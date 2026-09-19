/**
 * The exact count, without an API key.
 *
 * `fetch` is replaced so the arithmetic and the failure handling can be held
 * to something: that the baseline is subtracted rather than reported, that
 * each server gets its own count, and that one server the API refuses does not
 * take the rest of the run with it.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { exactly } from '../src/exact.ts';
import type { Inventory, ServerSpec } from '../src/types.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const spec = (name: string): ServerSpec => ({
  name,
  client: 'test',
  source: 'test',
  scope: 'user',
  transport: 'stdio',
  command: 'x',
  enabled: true,
  carriedBy: ['test'],
});

const inventory = (name: string, tools: number, error?: string): Inventory => ({
  server: spec(name),
  tools: Array.from({ length: tools }, (_, i) => ({ name: `t${i}`, description: 'd', inputSchema: { type: 'object' } })),
  prompts: [],
  resources: [],
  ms: 1,
  error,
});

/** Answers as the endpoint does: a baseline of 10, plus 100 per tool sent. */
function stubApi(): { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { tools?: unknown[] };
    bodies.push(body as Record<string, unknown>);
    return {
      ok: true,
      json: async () => ({ input_tokens: 10 + (body.tools?.length ?? 0) * 100 }),
    };
  }) as unknown as typeof fetch;
  return { bodies };
}

describe('exactly', () => {
  test('the baseline is subtracted, not reported', async () => {
    stubApi();
    const counts = await exactly([inventory('a', 3)], 'k');
    assert.equal(counts.get('a'), 300); // 10 + 3 * 100, less the baseline of 10
  });

  test('each server is counted on its own', async () => {
    stubApi();
    const counts = await exactly([inventory('a', 2), inventory('b', 5)], 'k');
    assert.equal(counts.get('a'), 200);
    assert.equal(counts.get('b'), 500);
  });

  test('tools go up under the name the model would see', async () => {
    const { bodies } = stubApi();
    await exactly([inventory('github', 1)], 'k');
    const sent = bodies.at(-1)?.['tools'] as { name: string }[];
    assert.equal(sent[0]?.name, 'mcp__github__t0');
  });

  test('a server that failed to answer is never sent', async () => {
    stubApi();
    const counts = await exactly([inventory('dead', 0, 'exited'), inventory('a', 1)], 'k');
    assert.equal(counts.has('dead'), false);
    assert.equal(counts.get('a'), 100);
  });

  test('one refused server leaves the others counted', async () => {
    const { bodies } = stubApi();
    const ok = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { tools?: { name: string }[] };
      if (body.tools?.[0]?.name.includes('__rejected__')) {
        return { ok: false, status: 400, text: async () => 'too many tools' };
      }
      return ok(url as never, init as never);
    }) as unknown as typeof fetch;

    const counts = await exactly([inventory('rejected', 1), inventory('fine', 2)], 'k');
    assert.equal(counts.has('rejected'), false);
    assert.equal(counts.get('fine'), 200);
    assert.ok(bodies.length > 0);
  });
});

/**
 * The transport, against a server that really speaks the protocol.
 *
 * Everything else in this suite is pure and could pass while the one part that
 * talks to the outside world is broken. These tests spawn `fixtures/server.mjs`
 * and hold it to the things that go wrong in the field: a banner printed to
 * stdout before the handshake, a listing that arrives in pages, a method the
 * server has never heard of, and a server that dies on startup.
 */

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';

import { inspect, inspectAll } from '../src/mcp.ts';
import type { ServerSpec } from '../src/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'server.mjs');

const fixture = (name: string, args: string[] = []): ServerSpec => ({
  name,
  client: 'test',
  source: 'test',
  scope: 'user',
  transport: 'stdio',
  command: process.execPath,
  args: [FIXTURE, ...args],
  enabled: true,
  carriedBy: ['test'],
});

describe('stdio', () => {
  test('lists what a server carries', async () => {
    const inv = await inspect(fixture('fx', ['--tools', '3']));
    assert.equal(inv.error, undefined);
    assert.equal(inv.tools.length, 3);
    assert.equal(inv.title, 'fixture 1.0.0');
    assert.equal(inv.tools[0]?.name, 'tool_0');
    assert.ok(inv.tools[0]?.inputSchema);
  });

  test('a banner on stdout does not break the handshake', async () => {
    // The fixture prints one unless told not to; this is the default case.
    const noisy = await inspect(fixture('noisy'));
    const quiet = await inspect(fixture('quiet', ['--silent']));
    assert.equal(noisy.error, undefined);
    assert.equal(noisy.tools.length, quiet.tools.length);
  });

  test('a listing that arrives in pages is followed to the end', async () => {
    const inv = await inspect(fixture('paged', ['--tools', '25', '--page', '10']));
    assert.equal(inv.tools.length, 25);
    assert.equal(new Set(inv.tools.map((t) => t.name)).size, 25);
  });

  test('a listing the server does not implement is empty, not fatal', async () => {
    const inv = await inspect(fixture('fx'));
    assert.equal(inv.error, undefined); // prompts/list answers -32601
    assert.equal(inv.prompts.length, 0);
  });

  test('a server that dies explains itself', async () => {
    const inv = await inspect(fixture('dead', ['--die']), 5000);
    assert.ok(inv.error, 'expected an error');
    assert.match(inv.error ?? '', /MCP_TOKEN|exited/);
    assert.equal(inv.tools.length, 0);
  });

  test('a command that does not exist is one failed row', async () => {
    const spec = { ...fixture('missing'), command: 'definitely-not-a-real-command-xyz', args: [] };
    const inv = await inspect(spec, 5000);
    assert.ok(inv.error);
  });

  test('a stdio entry with no command never spawns anything', async () => {
    const spec = { ...fixture('empty'), command: undefined };
    const inv = await inspect(spec, 5000);
    assert.match(inv.error ?? '', /no command/);
  });

  test('several servers are inspected together, in order', async () => {
    const specs = [fixture('a', ['--tools', '1']), fixture('b', ['--tools', '2']), fixture('c', ['--tools', '3'])];
    const done: string[] = [];
    const out = await inspectAll(specs, { lanes: 2, onDone: (inv) => done.push(inv.server.name) });

    assert.deepEqual(out.map((i) => i.server.name), ['a', 'b', 'c']);
    assert.deepEqual(out.map((i) => i.tools.length), [1, 2, 3]);
    assert.equal(done.length, 3);
  });

  test('a server that never answers is given up on', async () => {
    // `node -e` with an open stdin reads forever and says nothing.
    const spec: ServerSpec = { ...fixture('mute'), args: ['-e', 'process.stdin.resume()'] };
    const started = Date.now();
    const inv = await inspect(spec, 1200);
    assert.match(inv.error ?? '', /no answer in/);
    assert.ok(Date.now() - started < 8000, 'took too long to give up');
  });
});

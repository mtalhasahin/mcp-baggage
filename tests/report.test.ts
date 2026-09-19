import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseArgs } from '../src/cli.ts';
import { compact, report, shorten } from '../src/report.ts';
import { callsInLine } from '../src/usage.ts';
import { heaviestFirst, unused, weigh } from '../src/weigh.ts';
import type { Inventory, ServerSpec } from '../src/types.ts';

const spec = (name: string): ServerSpec => ({
  name,
  client: 'claude-code',
  source: `/home/.claude.json`,
  scope: 'user',
  transport: 'stdio',
  command: 'npx',
  args: [name],
  enabled: true,
  carriedBy: ['claude-code'],
});

const inventory = (name: string, tools: number, error?: string): Inventory => ({
  server: spec(name),
  tools: Array.from({ length: tools }, (_, i) => ({
    name: `tool_${i}`,
    description: `Does the ${i}th thing, at some length, the way a real server describes itself.`,
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'A path' } } },
  })),
  prompts: [],
  resources: [],
  ms: 100,
  error,
});

describe('compact', () => {
  test('small numbers are exact', () => {
    assert.equal(compact(412), '412');
  });
  test('thousands keep one decimal until they do not need it', () => {
    assert.equal(compact(12_400), '12.4k');
    assert.equal(compact(124_000), '124k');
  });
});

describe('weigh', () => {
  test('a server with more tools costs more', () => {
    const small = weigh(inventory('a', 3), () => null);
    const big = weigh(inventory('b', 30), () => null);
    assert.ok(big.tokens > small.tokens * 5);
  });

  test('tools come back heaviest first', () => {
    const w = weigh(inventory('a', 5), () => null);
    const sorted = [...w.tools].sort((x, y) => y.tokens - x.tokens);
    assert.deepEqual(w.tools.map((t) => t.tokens), sorted.map((t) => t.tokens));
  });

  test('servers come back heaviest first, ties broken by name', () => {
    const order = heaviestFirst([weigh(inventory('b', 2), () => null), weigh(inventory('a', 20), () => null)]);
    assert.equal(order[0]?.server.name, 'a');
  });

  test('a tool nobody called is waste; a tool nobody measured is not', () => {
    const measured = weigh(inventory('a', 3), () => 0);
    const unmeasured = weigh(inventory('a', 3), () => null);
    assert.equal(unused([measured]).length, 3);
    assert.equal(unused([unmeasured]).length, 0);
  });
});

describe('report', () => {
  test('says so plainly when there is nothing to weigh', () => {
    assert.match(report([]).join('\n'), /no MCP servers/);
  });

  test('a failed server is a row, not a crash, and is out of the total', () => {
    const text = report([weigh(inventory('broken', 0, 'server exited (1)'), () => null)]).join('\n');
    assert.match(text, /server exited \(1\)/);
    assert.match(text, /could not be reached/);
  });

  test('the estimate is labelled as one', () => {
    const text = report([weigh(inventory('a', 3), () => null)], { exact: false }).join('\n');
    assert.match(text, /estimated/);
  });

  test('an exact count is not labelled as an estimate', () => {
    const text = report([weigh(inventory('a', 3), () => null)], { exact: true }).join('\n');
    assert.doesNotMatch(text, /estimated/);
  });

  test('a server nobody has touched is one line, not forty', () => {
    const text = report([weigh(inventory('a', 4), () => 0)], { days: 30 }).join('\n');
    assert.match(text, /has not been called in 30 days/);
    assert.match(text, /nothing at all has been called from/);
    assert.match(text, /\.claude\.json/);
    // Its tools are covered by that one line and must not be listed again.
    assert.doesNotMatch(text, /mcp__a__tool_0/);
  });

  test('dead tools inside a server you do use are named', () => {
    // Only `tool_0` is ever reached for; the rest of the server is dead weight.
    const w = weigh(inventory('a', 4), (name) => (name.endsWith('tool_0') ? 5 : 0));
    const text = report([w], { days: 30 }).join('\n');
    assert.match(text, /in servers you do use/);
    assert.match(text, /mcp__a__tool_1/);
    assert.doesNotMatch(text, /nothing at all has been called from/);
  });

  test('a home directory is put back as a tilde', () => {
    assert.equal(shorten('/home/t/.claude.json', '/home/t'), '~/.claude.json');
    assert.equal(shorten('/elsewhere/x', '/home/t'), '/elsewhere/x');
  });

  test('usage it never measured is never printed as zero', () => {
    const text = report([weigh(inventory('a', 4), () => null)], { days: null }).join('\n');
    assert.doesNotMatch(text, /never called/);
  });
});

describe('callsInLine', () => {
  test('a tool_use block counts', () => {
    const line = JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'mcp__github__create_issue' }] } });
    assert.deepEqual(callsInLine(line), ['mcp__github__create_issue']);
  });

  test('a result echoing the name is not a second call', () => {
    const line = JSON.stringify({ message: { content: [{ type: 'tool_result', name: 'mcp__github__create_issue' }] } });
    assert.deepEqual(callsInLine(line), []);
  });

  test('a built-in tool is not an MCP tool', () => {
    const line = JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Read' }] } });
    assert.deepEqual(callsInLine(line), []);
  });

  test('a line that is not JSON is skipped', () => {
    assert.deepEqual(callsInLine('mcp__x__y but not json'), []);
  });
});

describe('parseArgs', () => {
  test('no arguments is a valid run', () => {
    const parsed = parseArgs([]);
    assert.ok(!('error' in parsed));
  });

  test('a bad flag is refused by name', () => {
    assert.match((parseArgs(['--nope']) as { error: string }).error, /--nope/);
  });

  test('a flag that needs a number says so', () => {
    assert.match((parseArgs(['--days', 'many']) as { error: string }).error, /positive number/);
  });

  test('numbers are read', () => {
    const parsed = parseArgs(['--days', '7', '--window', '1000000']);
    assert.equal((parsed as { days: number }).days, 7);
    assert.equal((parsed as { window: number }).window, 1_000_000);
  });

  test('help wins over everything else', () => {
    assert.ok('help' in parseArgs(['--tools', '--help']));
  });
});

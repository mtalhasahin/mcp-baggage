import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { candidates, identity, merge, parseConfig, type Candidate } from '../src/config.ts';
import { parseToml } from '../src/toml.ts';

const at = (client: string, scope: 'user' | 'project', format: 'json' | 'toml' = 'json'): Candidate => ({
  client,
  scope,
  path: `/fake/${client}`,
  format,
});

describe('candidates', () => {
  test('every client that keeps a config is looked for', () => {
    const clients = new Set(candidates('/proj', '/home').map((c) => c.client));
    for (const name of ['claude-code', 'cursor', 'codex', 'vscode', 'windsurf']) {
      assert.ok(clients.has(name), `${name} is not looked for`);
    }
  });

  test('project files are looked for inside the project', () => {
    const project = candidates('/proj', '/home').filter((c) => c.scope === 'project');
    assert.ok(project.length > 0);
    for (const c of project) assert.ok(c.path.includes('proj'), c.path);
  });
});

describe('parseConfig', () => {
  test('reads the shape Claude Code, Cursor and Windsurf use', () => {
    const specs = parseConfig(
      JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['-y', 'gh-mcp'] } } }),
      at('cursor', 'user'),
    );
    assert.equal(specs.length, 1);
    assert.equal(specs[0]?.name, 'github');
    assert.equal(specs[0]?.transport, 'stdio');
    assert.deepEqual(specs[0]?.args, ['-y', 'gh-mcp']);
  });

  test('reads the shape VS Code uses', () => {
    const specs = parseConfig(JSON.stringify({ servers: { docs: { type: 'http', url: 'https://x/mcp' } } }), at('vscode', 'project'));
    assert.equal(specs[0]?.transport, 'http');
    assert.equal(specs[0]?.url, 'https://x/mcp');
  });

  test('reads the shape Codex uses', () => {
    const toml = [
      'model = "gpt-5"',
      '',
      '[mcp_servers.linear]',
      'command = "npx"',
      'args = ["-y", "linear-mcp"]',
      '',
      '[mcp_servers.linear.env]',
      'LINEAR_KEY = "abc"',
    ].join('\n');
    const specs = parseConfig(toml, at('codex', 'user', 'toml'));
    assert.equal(specs.length, 1);
    assert.equal(specs[0]?.name, 'linear');
    assert.deepEqual(specs[0]?.args, ['-y', 'linear-mcp']);
    assert.equal(specs[0]?.env?.['LINEAR_KEY'], 'abc');
  });

  test('a server only this project declares is found', () => {
    const text = JSON.stringify({ projects: { '/proj': { mcpServers: { local: { command: './server' } } } } });
    assert.equal(parseConfig(text, at('claude-code', 'user'), '/proj').length, 1);
    assert.equal(parseConfig(text, at('claude-code', 'user'), '/elsewhere').length, 0);
  });

  test('a switched-off server is listed, not dropped', () => {
    const disabled = parseConfig(
      JSON.stringify({ mcpServers: { a: { command: 'x', disabled: true }, b: { command: 'y' } } }),
      at('cursor', 'user'),
    );
    assert.equal(disabled.length, 2);
    assert.equal(disabled.find((s) => s.name === 'a')?.enabled, false);
    assert.equal(disabled.find((s) => s.name === 'b')?.enabled, true);
  });

  test("Claude Code's own off-switch is understood", () => {
    const specs = parseConfig(
      JSON.stringify({ mcpServers: { a: { command: 'x' } }, disabledMcpjsonServers: ['a'] }),
      at('claude-code', 'project'),
    );
    assert.equal(specs[0]?.enabled, false);
  });

  test('an entry with neither a command nor a URL is not a server', () => {
    assert.equal(parseConfig(JSON.stringify({ mcpServers: { broken: { note: 'todo' } } }), at('cursor', 'user')).length, 0);
  });

  test('a corrupt file costs that file, not the run', () => {
    assert.deepEqual(parseConfig('{ not json', at('cursor', 'user')), []);
  });
});

describe('merge', () => {
  const github = (client: string, scope: 'user' | 'project') =>
    parseConfig(JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['gh-mcp'] } } }), at(client, scope));

  test('the same server in three configs is weighed once', () => {
    const merged = merge([...github('claude-code', 'user'), ...github('cursor', 'user'), ...github('windsurf', 'user')]);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0]?.carriedBy, ['claude-code', 'cursor', 'windsurf']);
  });

  test('a project entry overrides the machine-wide one', () => {
    const merged = merge([...github('claude-code', 'user'), ...github('claude-code', 'project')]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.scope, 'project');
  });

  test('two servers running different things stay apart', () => {
    const other = parseConfig(JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['other'] } } }), at('cursor', 'user'));
    assert.equal(merge([...github('cursor', 'user'), ...other]).length, 2);
  });

  test('identity is the thing that runs, not the name it was given', () => {
    const a = github('cursor', 'user')[0];
    const b = parseConfig(JSON.stringify({ mcpServers: { gh: { command: 'npx', args: ['gh-mcp'] } } }), at('codex', 'user'))[0];
    assert.equal(identity(a!), identity(b!));
  });
});

describe('parseToml', () => {
  test('inline tables and arrays survive', () => {
    const root = parseToml('[a]\nlist = ["x", "y"]\ninline = { k = "v", n = 3 }\non = true\n');
    const a = root['a'] as Record<string, unknown>;
    assert.deepEqual(a['list'], ['x', 'y']);
    assert.deepEqual(a['inline'], { k: 'v', n: 3 });
    assert.equal(a['on'], true);
  });

  test('comments are not values', () => {
    const root = parseToml('[a]\nk = "v" # trailing\n# whole line\n');
    assert.equal((root['a'] as Record<string, unknown>)['k'], 'v');
  });

  test('a hash inside a string is not a comment', () => {
    const root = parseToml('[a]\nk = "v#1"\n');
    assert.equal((root['a'] as Record<string, unknown>)['k'], 'v#1');
  });
});

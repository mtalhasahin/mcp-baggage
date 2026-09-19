/**
 * Where the servers are declared, and what they are.
 *
 * Every client keeps its own file in its own shape, and most people have the
 * same handful of servers in two or three of them. This finds the files, reads
 * whichever exist, and folds identical servers together — a server is the same
 * server when it is the same command or the same URL, whatever each config
 * chose to call it.
 */

import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseToml } from './toml.ts';
import type { ServerSpec } from './types.ts';

/** One config file that might exist. */
export type Candidate = { client: string; scope: 'user' | 'project'; path: string; format: 'json' | 'toml' };

/**
 * The files worth looking at, in the order a report should mention them.
 *
 * Project files come after the user ones for each client so that a project
 * entry overrides the machine-wide one of the same name, which is how every
 * client resolves it.
 */
export function candidates(cwd: string, home: string = homedir()): Candidate[] {
  return [
    { client: 'claude-code', scope: 'user', path: join(home, '.claude.json'), format: 'json' },
    { client: 'claude-code', scope: 'project', path: join(cwd, '.mcp.json'), format: 'json' },
    { client: 'cursor', scope: 'user', path: join(home, '.cursor', 'mcp.json'), format: 'json' },
    { client: 'cursor', scope: 'project', path: join(cwd, '.cursor', 'mcp.json'), format: 'json' },
    { client: 'vscode', scope: 'project', path: join(cwd, '.vscode', 'mcp.json'), format: 'json' },
    { client: 'windsurf', scope: 'user', path: join(home, '.codeium', 'windsurf', 'mcp_config.json'), format: 'json' },
    { client: 'codex', scope: 'user', path: join(home, '.codex', 'config.toml'), format: 'toml' },
  ];
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

const asStringMap = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(asRecord(v))) if (typeof val === 'string') out[k] = val;
  return out;
};

/**
 * One entry from a config, whatever the client called its fields.
 *
 * `disabled: true`, `enabled: false` and Claude Code's `disabledMcpjsonServers`
 * all mean the same thing and all end up here as `enabled: false` — a switched
 * off server is still listed, because knowing what you would pay to switch it
 * back on is half the question.
 */
function toSpec(name: string, raw: unknown, at: Candidate, offSwitch: Set<string>): ServerSpec | null {
  const entry = asRecord(raw);
  const url = typeof entry['url'] === 'string' ? entry['url'] : undefined;
  const command = typeof entry['command'] === 'string' ? entry['command'] : undefined;
  if (!url && !command) return null;

  const declared = typeof entry['type'] === 'string' ? entry['type'] : undefined;
  const transport = url || declared === 'http' || declared === 'sse' ? 'http' : 'stdio';

  const enabled = entry['disabled'] !== true && entry['enabled'] !== false && !offSwitch.has(name);

  const spec: ServerSpec = {
    name,
    client: at.client,
    source: at.path,
    scope: at.scope,
    transport,
    enabled,
    carriedBy: [at.client],
  };
  if (command) spec.command = command;
  const args = asStrings(entry['args']);
  if (args.length) spec.args = args;
  const env = asStringMap(entry['env']);
  if (Object.keys(env).length) spec.env = env;
  if (typeof entry['cwd'] === 'string') spec.cwd = entry['cwd'];
  if (url) spec.url = url;
  const headers = asStringMap(entry['headers']);
  if (Object.keys(headers).length) spec.headers = headers;
  return spec;
}

/**
 * The servers one file declares.
 *
 * Exported and taking text rather than a path so that it can be tested against
 * every client's shape without a filesystem: `mcpServers` for Claude Code,
 * Cursor and Windsurf, `servers` for VS Code, `mcp_servers` for Codex.
 */
export function parseConfig(text: string, at: Candidate, cwd?: string): ServerSpec[] {
  let root: Record<string, unknown>;
  try {
    root = at.format === 'toml' ? parseToml(text) : asRecord(JSON.parse(text));
  } catch {
    return [];
  }

  const offSwitch = new Set(asStrings(root['disabledMcpjsonServers']));

  // Claude Code's user config keeps per-project servers under the project's own
  // path, and those are the ones that apply when you are standing in it.
  const scoped = cwd ? asRecord(asRecord(root['projects'])[cwd]) : {};

  const tables = [root['mcpServers'], root['servers'], root['mcp_servers'], scoped['mcpServers']];
  const specs: ServerSpec[] = [];
  for (const table of tables) {
    for (const [name, raw] of Object.entries(asRecord(table))) {
      const spec = toSpec(name, raw, at, offSwitch);
      if (spec) specs.push(spec);
    }
  }
  return specs;
}

/** What makes two entries the same server: the thing that gets run, not the name. */
export function identity(spec: ServerSpec): string {
  if (spec.transport === 'http') return `http:${spec.url}`;
  return `stdio:${spec.command} ${(spec.args ?? []).join(' ')}`.trim();
}

/**
 * Folds duplicates together.
 *
 * The first sighting wins the name and the file shown, later ones only add
 * their client to `carriedBy` — except that a project-scoped entry replaces a
 * user-scoped one, which is the override every client applies.
 */
export function merge(specs: readonly ServerSpec[]): ServerSpec[] {
  const byIdentity = new Map<string, ServerSpec>();
  for (const spec of specs) {
    const id = identity(spec);
    const held = byIdentity.get(id);
    if (!held) {
      byIdentity.set(id, { ...spec, carriedBy: [...spec.carriedBy] });
      continue;
    }
    if (!held.carriedBy.includes(spec.client)) held.carriedBy.push(spec.client);
    if (spec.scope === 'project' && held.scope === 'user') {
      byIdentity.set(id, { ...spec, carriedBy: held.carriedBy });
    }
  }
  return [...byIdentity.values()];
}

/** Every server declared on this machine, for this directory. */
export async function discover(cwd: string, home?: string): Promise<{ specs: ServerSpec[]; files: string[] }> {
  const files: string[] = [];
  const found: ServerSpec[] = [];

  for (const at of candidates(cwd, home)) {
    let text: string;
    try {
      text = await readFile(at.path, 'utf8');
    } catch {
      continue;
    }
    const specs = parseConfig(text, at, cwd);
    if (specs.length) files.push(at.path);
    found.push(...specs);
  }
  return { specs: merge(found), files };
}

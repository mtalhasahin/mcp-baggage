/**
 * The report, as lines of text.  [PURE]
 *
 * One table, then the sentence the table is for. The table is the evidence and
 * the sentence is the point: a number nobody reads changes nothing, and what
 * this has to say is short enough to fit in one — *every request carries this
 * much, and this much of it has never been used*.
 *
 * Lines rather than console calls, so the same report can be printed, written
 * to a file or asserted on in a test.
 */

import { totalTokens } from './weigh.ts';
import type { ServerSpec, WeighedServer, WeighedTool } from './types.ts';

/** The context window a share is measured against, when none is given. */
export const DEFAULT_WINDOW = 200_000;

/** How many individual tools to name before the list stops earning its space. */
const TOOL_LIST = 8;

/** `412`, `12.4k`, `1.2M` — a token count that fits a column. */
export function compact(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 100_000) return `${Math.round(n / 100) / 10}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${Math.round(n / 100_000) / 10}M`;
}

const share = (n: number, window: number): string => `${((n / window) * 100).toFixed(1)}%`;

/** A path with the home directory put back as `~`, so a line fits a terminal. */
export function shorten(path: string, home?: string): string {
  if (!home) return path;
  const same = (a: string): string => a.replace(/\\/g, '/').toLowerCase();
  return same(path).startsWith(same(home)) ? `~${path.slice(home.length)}` : path;
}

/** Where a server came from, in as few words as the reader needs. */
export function origin(spec: ServerSpec): string {
  const clients = spec.carriedBy.join(', ');
  return spec.scope === 'project' ? `${clients} (project)` : clients;
}

const NAME_WIDTH = 20;

function row(s: WeighedServer, window: number): string {
  const name = s.server.name.padEnd(NAME_WIDTH).slice(0, NAME_WIDTH);
  if (s.error) return `  ${name} ${'—'.padStart(5)} ${'—'.padStart(8)} ${'—'.padStart(7)} ${'—'.padStart(7)}  ${s.error}`;

  const used = s.tools.filter((t) => (t.calls ?? 0) > 0).length;
  const known = s.tools.some((t) => t.calls !== null);
  const usage = known ? `${used}/${s.tools.length}` : '—';
  const idle = known && used === 0 && s.tools.length > 0 ? '  never called' : '';
  const off = s.server.enabled ? '' : '  (switched off)';

  return (
    `  ${name}` +
    ` ${String(s.tools.length).padStart(5)}` +
    ` ${compact(s.tokens).padStart(8)}` +
    ` ${share(s.tokens, window).padStart(7)}` +
    ` ${usage.padStart(7)}` +
    idle +
    off
  );
}

const HEAD = `  ${'server'.padEnd(NAME_WIDTH)} ${'tools'.padStart(5)} ${'tokens'.padStart(8)} ${'of ctx'.padStart(7)} ${'used'.padStart(7)}`;

/**
 * What is being paid for and not used, split two ways.
 *
 * A server where nothing at all has been called is one decision — switch the
 * server off — and naming its forty tools one by one buries that decision in a
 * list. A server that is half used is the opposite: the server stays, and the
 * only thing worth printing is which of its tools are dead weight. So whole
 * dead servers are reported as servers, and loose tools only from the servers
 * that survive.
 */
export function idleness(servers: readonly WeighedServer[]): {
  servers: WeighedServer[];
  tools: WeighedTool[];
  tokens: number;
} {
  const dead = servers.filter((s) => !s.error && s.tools.length > 0 && s.tools.every((t) => t.calls === 0));
  const deadNames = new Set(dead.map((s) => s.server.name));

  const tools = servers
    .filter((s) => !s.error && !deadNames.has(s.server.name))
    .flatMap((s) => s.tools)
    .filter((t) => t.calls === 0)
    .sort((a, b) => b.tokens - a.tokens);

  return {
    servers: dead,
    tools,
    tokens: totalTokens(dead) + tools.reduce((n, t) => n + t.tokens, 0),
  };
}

/**
 * The whole report.
 *
 * `exact` is carried through to the wording rather than hidden: a figure that
 * came from a heuristic and one that came from the API's own counter should
 * not read identically.
 */
export function report(
  servers: readonly WeighedServer[],
  options: { window?: number; days?: number | null; exact?: boolean; home?: string } = {},
): string[] {
  if (servers.length === 0) return ['no MCP servers found in any config on this machine'];

  const window = options.window ?? DEFAULT_WINDOW;
  const live = servers.filter((s) => !s.error);
  const total = totalTokens(live);
  const toolCount = live.reduce((n, s) => n + s.tools.length, 0);

  const lines: string[] = [HEAD, ''];
  for (const s of servers) lines.push(row(s, window));

  lines.push(
    '',
    `  ${'total'.padEnd(NAME_WIDTH)} ${String(toolCount).padStart(5)} ${compact(total).padStart(8)} ${share(total, window).padStart(7)}`,
    '',
    `every request carries ${compact(total)} tokens of tool definitions — ${share(total, window)} of a ${compact(window)} window,`,
    `before a line of your own code is read. (${options.exact ? 'counted by the API' : 'estimated — --exact counts'})`,
  );

  if (options.days) {
    const idle = idleness(servers);
    if (idle.tokens > 0) {
      const portion = total > 0 ? Math.round((idle.tokens / total) * 100) : 100;
      lines.push('', `${compact(idle.tokens)} of it — ${portion}% — has not been called in ${options.days} days.`);
    }

    if (idle.servers.length > 0) {
      lines.push('', 'nothing at all has been called from:', '');
      for (const s of idle.servers) {
        lines.push(
          `  ${s.server.name.padEnd(NAME_WIDTH)} ${compact(s.tokens).padStart(8)}  ${shorten(s.server.source, options.home)}`,
        );
      }
    }

    if (idle.tools.length > 0) {
      lines.push('', 'and these tools, in servers you do use:', '');
      for (const t of idle.tools.slice(0, TOOL_LIST)) {
        lines.push(`  ${t.qualified.padEnd(44).slice(0, 44)} ${compact(t.tokens).padStart(7)}`);
      }
      if (idle.tools.length > TOOL_LIST) lines.push(`  … and ${idle.tools.length - TOOL_LIST} more`);
    }
  }

  const failed = servers.filter((s) => s.error);
  if (failed.length > 0) {
    const s = failed.length === 1;
    lines.push('', `${failed.length} server${s ? '' : 's'} could not be reached and ${s ? 'is' : 'are'} not in the total.`);
  }

  return lines;
}

/** Every tool of every server, heaviest first — the long form, behind a flag. */
export function breakdown(servers: readonly WeighedServer[]): string[] {
  const lines: string[] = [];
  for (const s of servers) {
    if (s.error) continue;
    lines.push('', `${s.server.name}${s.title ? `  (${s.title})` : ''}  ·  ${compact(s.tokens)}  ·  ${origin(s.server)}`);
    for (const t of s.tools) {
      const calls = t.calls === null ? '' : t.calls === 0 ? '   never called' : `   ${t.calls} call${t.calls === 1 ? '' : 's'}`;
      lines.push(`  ${t.name.padEnd(40).slice(0, 40)} ${compact(t.tokens).padStart(7)}${calls}`);
    }
  }
  return lines;
}

/** The same figures, for a script rather than a person. */
export function asJson(servers: readonly WeighedServer[], window: number, exact: boolean): unknown {
  return {
    window,
    exact,
    total: totalTokens(servers.filter((s) => !s.error)),
    servers: servers.map((s) => ({
      name: s.server.name,
      client: s.server.client,
      carriedBy: s.server.carriedBy,
      source: s.server.source,
      transport: s.server.transport,
      enabled: s.server.enabled,
      title: s.title,
      tokens: s.tokens,
      tools: s.tools,
      prompts: s.prompts,
      resources: s.resources,
      ms: s.ms,
      error: s.error,
    })),
  };
}

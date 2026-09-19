/**
 * The library, for anything that wants the figures without the table.
 *
 * A CI check that fails when a config grows past a budget is the obvious one,
 * and it needs `scan()` and a number — not a report.
 */

import { discover } from './config.ts';
import { inspectAll } from './mcp.ts';
import { lookup, readUsage } from './usage.ts';
import { heaviestFirst, totalTokens, weigh } from './weigh.ts';
import type { WeighedServer } from './types.ts';

export type ScanOptions = {
  cwd?: string;
  /** Days of transcripts to read for usage; `0` skips them and leaves usage unknown. */
  days?: number;
  timeout?: number;
  /** Include servers the config has switched off. */
  all?: boolean;
};

export type Scan = {
  servers: WeighedServer[];
  /** Tokens every request carries, across every server that answered. */
  tokens: number;
  /** The config files that had something in them. */
  files: string[];
};

/** Find every server, weigh it, and say what it costs. */
export async function scan(options: ScanOptions = {}): Promise<Scan> {
  const cwd = options.cwd ?? process.cwd();
  const { specs, files } = await discover(cwd);
  const wanted = specs.filter((s) => options.all || s.enabled);

  const inventories = await inspectAll(wanted, { timeout: options.timeout });
  const usage = options.days === 0 ? null : await readUsage(options.days);
  const callsOf = lookup(usage);

  const servers = heaviestFirst(inventories.map((inv) => weigh(inv, callsOf)));
  return { servers, tokens: totalTokens(servers.filter((s) => !s.error)), files };
}

export { candidates, discover, identity, merge, parseConfig } from './config.ts';
export { exactly } from './exact.ts';
export { inspect, inspectAll } from './mcp.ts';
export { asJson, breakdown, compact, DEFAULT_WINDOW, idleness, origin, report, shorten } from './report.ts';
export { estimate, TOOL_FRAMING } from './tokens.ts';
export { callsInLine, lookup, readUsage } from './usage.ts';
export { heaviestFirst, qualify, serialize, totalTokens, unused, weigh } from './weigh.ts';
export type * from './types.ts';

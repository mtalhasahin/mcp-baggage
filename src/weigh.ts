/**
 * What a server's listing is worth, in tokens.  [PURE]
 *
 * A tool does not reach the model as the server wrote it. The client renames
 * it — `mcp__github__create_issue` rather than `create_issue` — and sends the
 * name, the description and the input schema as one JSON object per tool, on
 * every single request. That serialized form is what this weighs, because
 * that is what is actually paid for, turn after turn, whether or not the tool
 * is ever called.
 */

import { estimate, TOOL_FRAMING } from './tokens.ts';
import type { Inventory, ToolDef, WeighedServer, WeighedTool } from './types.ts';

/** The name a client shows the model. The separator is `__` across all of them. */
export function qualify(server: string, tool: string): string {
  return `mcp__${server.replace(/[^A-Za-z0-9_-]/g, '_')}__${tool}`;
}

/**
 * A tool as the request carries it.
 *
 * `input_schema` rather than `inputSchema`: the wire format between client and
 * server is camelCase, the one between client and model is snake_case, and the
 * second is the one being billed.
 */
export function serialize(tool: ToolDef, qualified: string): string {
  return JSON.stringify({
    name: qualified,
    description: tool.description ?? '',
    input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
  });
}

export function weighTool(tool: ToolDef, serverName: string, calls: number | null): WeighedTool {
  const qualified = qualify(serverName, tool.name);
  return {
    name: tool.name,
    qualified,
    tokens: estimate(serialize(tool, qualified)) + TOOL_FRAMING,
    calls,
  };
}

/**
 * The whole listing, weighed.
 *
 * Prompts and resources are counted but kept apart from the total: most
 * clients list them lazily and only a few put them in the system prompt, so
 * folding them into one number would overstate what every turn costs. The
 * report shows them as a separate line.
 */
export function weigh(inv: Inventory, callsOf: (qualified: string) => number | null): WeighedServer {
  const tools = inv.tools.map((t) => weighTool(t, inv.server.name, callsOf(qualify(inv.server.name, t.name))));
  return {
    server: inv.server,
    title: inv.title,
    tools: tools.sort((a, b) => b.tokens - a.tokens),
    tokens: tools.reduce((n, t) => n + t.tokens, 0),
    prompts: inv.prompts.length,
    resources: inv.resources.length,
    ms: inv.ms,
    error: inv.error,
  };
}

/** Servers first by what they cost, then by name, so a report is stable run to run. */
export function heaviestFirst(servers: WeighedServer[]): WeighedServer[] {
  return servers
    .slice()
    .sort((a, b) => b.tokens - a.tokens || a.server.name.localeCompare(b.server.name));
}

export const totalTokens = (servers: readonly WeighedServer[]): number =>
  servers.reduce((n, s) => n + s.tokens, 0);

/**
 * Tools that were paid for and never called.
 *
 * `calls === null` means no transcript was read, which is not the same as zero
 * and is never reported as waste.
 */
export function unused(servers: readonly WeighedServer[]): WeighedTool[] {
  return servers
    .flatMap((s) => s.tools)
    .filter((t) => t.calls === 0)
    .sort((a, b) => b.tokens - a.tokens);
}

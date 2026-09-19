/**
 * The exact count, when an estimate is not good enough.
 *
 * Anthropic's `count_tokens` endpoint takes the same `tools` array a real
 * request would and answers with the number the model would actually be
 * charged — framing, separators and all. It bills nothing and needs no
 * inference, so `--exact` costs an API key and a second, not money.
 *
 * A baseline call with no tools is subtracted, because the endpoint counts the
 * whole request and the question here is only what the tools added.
 */

import { qualify } from './weigh.ts';
import type { Inventory, ToolDef } from './types.ts';

const ENDPOINT = 'https://api.anthropic.com/v1/messages/count_tokens';

/** Any model prices the same count; this one is picked for being cheap to name. */
const MODEL = 'claude-sonnet-5';

type ApiTool = { name: string; description: string; input_schema: unknown };

const toApi = (tool: ToolDef, server: string): ApiTool => ({
  name: qualify(server, tool.name),
  description: tool.description ?? '',
  input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
});

async function count(tools: ApiTool[], apiKey: string): Promise<number> {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: 'x' }],
      ...(tools.length ? { tools } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`count_tokens: HTTP ${response.status} ${await response.text().catch(() => '')}`.trim());
  }
  const body = (await response.json()) as { input_tokens?: number };
  if (typeof body.input_tokens !== 'number') throw new Error('count_tokens: no input_tokens in the answer');
  return body.input_tokens;
}

/**
 * Exact totals, one server at a time.
 *
 * Per server rather than per tool: a server with forty tools would be forty
 * round trips for a breakdown nobody acts on, and the decision this informs —
 * keep it or switch it off — is made at the server.
 *
 * Returns a map of server name to tokens. A server that errors is left out,
 * and the caller keeps its estimate.
 */
export async function exactly(inventories: readonly Inventory[], apiKey: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const baseline = await count([], apiKey);

  for (const inv of inventories) {
    if (inv.error || inv.tools.length === 0) continue;
    try {
      const withTools = await count(
        inv.tools.map((t) => toApi(t, inv.server.name)),
        apiKey,
      );
      out.set(inv.server.name, Math.max(0, withTools - baseline));
    } catch {
      // Keep the estimate for this one; one refused server is not a failed run.
    }
  }
  return out;
}

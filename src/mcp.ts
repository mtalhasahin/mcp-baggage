/**
 * A minimal MCP client — enough to ask a server what it carries, and no more.
 *
 * The official SDK would do this, and would also pull a dependency tree into a
 * tool whose whole subject is weight. What is needed here is four messages:
 * `initialize`, the `initialized` notification, and then the three listings.
 * No tool is ever called, nothing is written, and the connection is closed as
 * soon as the listing is in hand.
 *
 * Both transports are spoken because both are in people's configs: stdio,
 * where the server is a process this spawns, and streamable HTTP, where it is
 * a URL. A server that fails is reported as a failed row rather than taken as
 * a reason to stop — one broken entry in a config should not cost the run.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { Inventory, PromptDef, ResourceDef, ServerSpec, ToolDef } from './types.ts';

/** The version this announces. Servers negotiate down; none of them refuse a listing. */
const PROTOCOL = '2025-06-18';

const CLIENT = { name: 'mcp-baggage', version: '0.1.0' };

/** How long one server gets, all in, before it is written off. */
export const DEFAULT_TIMEOUT = 20_000;

type Rpc = { jsonrpc: '2.0'; id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Tool entries, defensively: a server that sends nonsense loses that entry, not the row. */
function toTools(raw: unknown): ToolDef[] {
  return asArray(raw)
    .map((t) => (t && typeof t === 'object' ? (t as Record<string, unknown>) : {}))
    .filter((t) => typeof t['name'] === 'string')
    .map((t) => ({
      name: t['name'] as string,
      description: typeof t['description'] === 'string' ? t['description'] : undefined,
      inputSchema: t['inputSchema'] ?? t['input_schema'],
      outputSchema: t['outputSchema'],
      annotations: t['annotations'],
    }));
}

/**
 * One live conversation with a server.
 *
 * `request` is the only thing callers need; the transports differ in how a
 * message gets there and how the answer comes back, not in what is said.
 */
type Session = {
  request: (method: string, params?: unknown) => Promise<unknown>;
  notify: (method: string, params?: unknown) => Promise<void>;
  close: () => void;
};

/**
 * How to start the process.
 *
 * Almost every server in a config is `npx` or `uvx`, which on Windows are
 * `.cmd` shims that `CreateProcess` will not run — the shell has to. So on
 * Windows the whole thing becomes one quoted command line handed to `cmd`,
 * rather than a command plus an argument array: passing both is what Node
 * deprecated, because the arguments would be concatenated unescaped.
 */
export function stdioOptions(spec: ServerSpec): { command: string; args: string[]; shell: boolean } {
  const args = spec.args ?? [];
  if (process.platform !== 'win32') return { command: spec.command as string, args, shell: false };
  const quote = (s: string): string => (s === '' || /[\s"&|<>^()]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return { command: [spec.command as string, ...args].map(quote).join(' '), args: [], shell: true };
}

function openStdio(spec: ServerSpec): Session {
  const { command, args, shell } = stdioOptions(spec);
  const child = spawn(command, args, {
    shell,
    cwd: spec.cwd ?? process.cwd(),
    env: { ...process.env, ...spec.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  let stderr = '';

  child.stderr.on('data', (chunk: Buffer) => {
    // Kept only to explain a failure; a chatty server must not fill memory.
    stderr = (stderr + chunk.toString()).slice(-2000);
  });

  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    if (!line.trim().startsWith('{')) return; // servers that log to stdout anyway
    let message: Rpc;
    try {
      message = JSON.parse(line) as Rpc;
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message ?? 'server returned an error'));
    else waiter.resolve(message.result);
  });

  const fail = (reason: string): void => {
    const error = new Error(stderr.trim() ? `${reason}: ${stderr.trim().split('\n').slice(-1)[0]}` : reason);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  child.on('error', (e) => fail(e.message));
  child.on('exit', (code) => fail(`server exited (${code ?? 'signal'})`));

  const send = (payload: unknown): void => {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  return {
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        send({ jsonrpc: '2.0', id, method, params: params ?? {} });
      }),
    notify: async (method, params) => {
      send({ jsonrpc: '2.0', method, params: params ?? {} });
    },
    close: () => {
      lines.close();
      child.stdin.end();
      child.kill();
    },
  };
}

/**
 * Streamable HTTP.
 *
 * The answer to a POST is either a JSON body or an SSE stream carrying the
 * same object, and the spec allows a server to choose per request, so both are
 * read. The session id the server hands back on `initialize` has to ride along
 * on everything after it.
 */
function openHttp(spec: ServerSpec, signal: AbortSignal): Session {
  const url = spec.url as string;
  let sessionId: string | undefined;
  let nextId = 1;

  const post = async (payload: unknown): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL,
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        ...spec.headers,
      },
      body: JSON.stringify(payload),
    });

  /** An SSE body, reduced to the one JSON-RPC object that was asked for. */
  const fromStream = (text: string, id: number): Rpc | undefined => {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try {
        const message = JSON.parse(line.slice(5).trim()) as Rpc;
        if (message.id === id) return message;
      } catch {
        // A comment or a keep-alive; the next line may still be the answer.
      }
    }
    return undefined;
  };

  return {
    request: async (method, params) => {
      const id = nextId++;
      const response = await post({ jsonrpc: '2.0', id, method, params: params ?? {} });
      const handed = response.headers.get('mcp-session-id');
      if (handed) sessionId = handed;
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());

      const text = await response.text();
      const message = response.headers.get('content-type')?.includes('text/event-stream')
        ? fromStream(text, id)
        : (JSON.parse(text) as Rpc);
      if (!message) throw new Error('no answer in the stream');
      if (message.error) throw new Error(message.error.message ?? 'server returned an error');
      return message.result;
    },
    notify: async (method, params) => {
      await post({ jsonrpc: '2.0', method, params: params ?? {} });
    },
    close: () => {},
  };
}

/** Lists that come back a page at a time; a server with 200 tools sends several. */
async function listAll(session: Session, method: string, field: string): Promise<unknown[]> {
  const items: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const result = (await session.request(method, cursor ? { cursor } : {})) as Record<string, unknown> | null;
    if (!result) break;
    items.push(...asArray(result[field]));
    cursor = typeof result['nextCursor'] === 'string' ? result['nextCursor'] : undefined;
    if (!cursor) break;
  }
  return items;
}

/** A listing a server does not support is an empty listing, not a failure. */
async function listOrNone(session: Session, method: string, field: string): Promise<unknown[]> {
  try {
    return await listAll(session, method, field);
  } catch {
    return [];
  }
}

/**
 * Ask one server what it carries.
 *
 * Never throws: a server that cannot be reached comes back as an inventory
 * with an `error` and no tools, which is a row in the report like any other.
 */
export async function inspect(spec: ServerSpec, timeout = DEFAULT_TIMEOUT): Promise<Inventory> {
  const started = Date.now();
  const empty = { server: spec, tools: [], prompts: [], resources: [] };

  if (spec.transport === 'stdio' && !spec.command) {
    return { ...empty, ms: 0, error: 'no command in the config' };
  }

  const controller = new AbortController();
  const session = spec.transport === 'stdio' ? openStdio(spec) : openHttp(spec, controller.signal);
  const expiry = setTimeout(() => controller.abort(), timeout);

  const giveUp = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error(`no answer in ${Math.round(timeout / 1000)}s`)));
  });

  try {
    const handshake = (await Promise.race([
      session.request('initialize', {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: CLIENT,
      }),
      giveUp,
    ])) as Record<string, unknown> | null;

    await session.notify('notifications/initialized');

    const info = (handshake?.['serverInfo'] ?? {}) as Record<string, unknown>;
    const name = typeof info['name'] === 'string' ? info['name'] : undefined;
    const version = typeof info['version'] === 'string' ? info['version'] : undefined;

    const [tools, prompts, resources] = (await Promise.race([
      Promise.all([
        listOrNone(session, 'tools/list', 'tools'),
        listOrNone(session, 'prompts/list', 'prompts'),
        listOrNone(session, 'resources/list', 'resources'),
      ]),
      giveUp,
    ])) as [unknown[], unknown[], unknown[]];

    return {
      server: spec,
      title: name ? (version ? `${name} ${version}` : name) : undefined,
      tools: toTools(tools),
      prompts: prompts as PromptDef[],
      resources: resources as ResourceDef[],
      ms: Date.now() - started,
    };
  } catch (e) {
    return { ...empty, ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(expiry);
    controller.abort();
    session.close();
  }
}

/**
 * Every server, a few at a time.
 *
 * Each one is a process to spawn, so they are not all started at once; four in
 * flight keeps a machine with a dozen servers responsive and still finishes in
 * about the time the slowest handful take.
 */
export async function inspectAll(
  specs: readonly ServerSpec[],
  options: { timeout?: number; lanes?: number; onDone?: (inv: Inventory) => void } = {},
): Promise<Inventory[]> {
  const lanes = Math.max(1, options.lanes ?? 4);
  const out: Inventory[] = new Array(specs.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const spec = specs[index];
      if (!spec) return;
      const inv = await inspect(spec, options.timeout);
      out[index] = inv;
      options.onDone?.(inv);
    }
  };

  await Promise.all(Array.from({ length: Math.min(lanes, specs.length) }, worker));
  return out;
}

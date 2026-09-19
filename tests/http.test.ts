/**
 * The HTTP transport, against a real server on a real port.
 *
 * The spec lets a server answer the same POST with a JSON body or with an SSE
 * stream, and choose per request — so both are served here, along with the
 * session id that has to ride along on every message after the handshake.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, describe, test } from 'node:test';

import { inspect } from '../src/mcp.ts';
import type { ServerSpec } from '../src/types.ts';

const tools = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    name: `tool_${i}`,
    description: 'Does a thing, described at the length a real server describes it.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  }));

/**
 * Starts a server that answers MCP over HTTP.
 *
 * `mode` is how it answers: a plain JSON body, or an SSE stream with the
 * answer among keep-alive lines. `seen` records the session id each request
 * carried, so the test can hold the client to sending it back.
 */
async function start(mode: 'json' | 'sse', count = 4): Promise<{ url: string; seen: (string | undefined)[]; server: Server }> {
  const seen: (string | undefined)[] = [];

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push(req.headers['mcp-session-id'] as string | undefined);
      const message = JSON.parse(body) as { id?: number; method?: string };

      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }

      const result =
        message.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'over-http', version: '2.0' } }
          : message.method === 'tools/list'
            ? { tools: tools(count) }
            : { prompts: [], resources: [] };

      const answer = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
      const headers: Record<string, string> = {};
      if (message.method === 'initialize') headers['mcp-session-id'] = 'session-123';

      if (mode === 'json') {
        res.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(answer);
      } else {
        res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' });
        res.end(`: keep-alive\n\nevent: message\ndata: ${answer}\n\n`);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/mcp`, seen, server };
}

const spec = (url: string): ServerSpec => ({
  name: 'remote',
  client: 'test',
  source: 'test',
  scope: 'user',
  transport: 'http',
  url,
  enabled: true,
  carriedBy: ['test'],
});

const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
});

describe('http', () => {
  test('reads a listing from a JSON answer', async () => {
    const { url, server } = await start('json', 4);
    servers.push(server);

    const inv = await inspect(spec(url), 5000);
    assert.equal(inv.error, undefined);
    assert.equal(inv.tools.length, 4);
    assert.equal(inv.title, 'over-http 2.0');
  });

  test('reads the same listing out of an SSE stream', async () => {
    const { url, server } = await start('sse', 7);
    servers.push(server);

    const inv = await inspect(spec(url), 5000);
    assert.equal(inv.error, undefined);
    assert.equal(inv.tools.length, 7);
  });

  test('the session id is sent back on everything after the handshake', async () => {
    const { url, seen, server } = await start('json');
    servers.push(server);

    await inspect(spec(url), 5000);
    assert.equal(seen[0], undefined, 'the handshake cannot carry one yet');
    assert.ok(seen.length > 1);
    assert.ok(
      seen.slice(1).every((id) => id === 'session-123'),
      `session id was dropped: ${JSON.stringify(seen)}`,
    );
  });

  test('a refusal is a failed row, not a crash', async () => {
    const server = createServer((_req, res) => res.writeHead(401, { 'content-type': 'text/plain' }).end('no'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const port = (server.address() as { port: number }).port;

    const inv = await inspect(spec(`http://127.0.0.1:${port}/mcp`), 5000);
    assert.match(inv.error ?? '', /401/);
  });

  test('nothing listening is one failed row', async () => {
    // Port 1 is privileged and never a server; the connection is refused at once.
    const inv = await inspect(spec('http://127.0.0.1:1/mcp'), 5000);
    assert.ok(inv.error);
    assert.equal(inv.tools.length, 0);
  });
});

#!/usr/bin/env node
/**
 * A real MCP server, small enough to reason about.
 *
 * It exists so the stdio transport is tested against something that actually
 * speaks the protocol rather than a mock of it: the handshake, the notification
 * that follows it, a paginated `tools/list`, a `prompts/list` that is not
 * implemented, and a line of noise on stdout before any of it — which real
 * servers do emit, and which used to be enough to break a client.
 *
 *   node server.mjs [--tools N] [--page N] [--silent] [--die]
 */

import { createInterface } from 'node:readline';

const arg = (flag, fallback) => {
  const at = process.argv.indexOf(flag);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
};

const TOOLS = arg('--tools', 3);
const PAGE = arg('--page', 100);

if (process.argv.includes('--die')) {
  process.stderr.write('MCP_TOKEN is not set\n');
  process.exit(1);
}

if (!process.argv.includes('--silent')) {
  // The noise a client has to survive: a startup banner on stdout.
  process.stdout.write('starting fixture server…\n');
}

const tools = Array.from({ length: TOOLS }, (_, i) => ({
  name: `tool_${i}`,
  description: `Does the ${i}th thing. Written at the length a real server writes at, which is most of the cost.`,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the file to act on' },
      limit: { type: 'number', description: 'How many items to return' },
    },
    required: ['path'],
  },
}));

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const page = (cursor) => {
  const from = cursor ? Number(cursor) : 0;
  const slice = tools.slice(from, from + PAGE);
  const next = from + PAGE < tools.length ? String(from + PAGE) : undefined;
  return { tools: slice, ...(next ? { nextCursor: next } : {}) };
};

createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return; // a notification; nothing to answer

  const reply = (result) => send({ jsonrpc: '2.0', id: message.id, result });

  switch (message.method) {
    case 'initialize':
      reply({
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1.0.0' },
      });
      break;
    case 'tools/list':
      reply(page(message.params?.cursor));
      break;
    case 'resources/list':
      reply({ resources: [] });
      break;
    default:
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } });
  }
});

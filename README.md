# Baggage

**What each MCP server carries into your context window, and how much of it you actually use.**

Installing an MCP server is free. Keeping one is not. Every tool a server declares is sent to the
model on every single request — its name, its description and its whole JSON schema — whether or not
anything ever calls it. Ten servers is a few thousand tokens off the top of every turn, in every
session, forever. Nobody shows you that number.

```
npx mcp-baggage
```

```
  server               tools   tokens  of ctx    used

  playwright              24     8.9k    4.5%    0/24  never called
  github                  35     6.1k    3.1%    3/35
  filesystem              14     2.4k    1.2%    9/14
  sentry                  12     1.4k    0.7%    1/12
  postgres                 6      702    0.4%     4/6
  broken                   —        —       —       —  server exited (1): MCP_TOKEN is not set

  total                   91    19.5k    9.8%

every request carries 19.5k tokens of tool definitions — 9.8% of a 200k window,
before a line of your own code is read. (estimated — --exact counts)

12.7k of it — 65% — has not been called in 30 days.

nothing at all has been called from:

  playwright               8.9k  ~/.cursor/mcp.json

and these tools, in servers you do use:

  mcp__github__create_or_update_file               287
  mcp__github__list_workflow_runs                  241
  mcp__github__update_pull_request_branch          224
  … and 29 more
```

The two halves of that table are the whole idea. The left is what you pay on every request. The
right is what you got for it. Nobody sets out to spend a tenth of their context on a browser
automation server they last used in March — it is just that the cost is invisible and the decision
was never put in front of them.

---

## What it does

- Finds every MCP config on the machine — Claude Code, Cursor, Codex, VS Code, Windsurf — and reads
  whichever exist.
- Starts each server, asks it what it carries, and closes the connection. **No tool is ever called.**
- Weighs each tool as the model will be shown it: `mcp__server__tool`, the description and the input
  schema, serialized the way the request serializes it.
- Reads your Claude Code transcripts for `tool_use` blocks, so every tool gets a count of the times
  it was actually reached for.
- Folds duplicates: the same server in three configs is weighed once and the report names all three.

## What it does not do

It does not call tools, write files, change any config, or send your schemas anywhere — except under
`--exact`, which posts the tool definitions to Anthropic's token-counting endpoint and nothing else.
It has no dependencies. It spawns the servers your own config already tells your editor to spawn,
and you can see exactly which ones first:

```bash
npx mcp-baggage --list
```

---

## The number

There is no public tokenizer for Claude, so the default figure is an estimate. It is not
`length / 4`: tool definitions are JSON, and JSON is mostly punctuation, indentation and short
identifiers, which that ratio gets wrong in both directions at once. Instead the text is cut into
runs — letters, digits, whitespace, punctuation — and each is priced the way a byte-pair tokenizer
is known to treat it.

It is a model of a tokenizer, not the tokenizer, and it is good enough for the question it is for:
*which of these is the big one*. When the number itself has to be right:

```bash
ANTHROPIC_API_KEY=... npx mcp-baggage --exact
```

That sends each server's tool definitions to `/v1/messages/count_tokens`, which returns what the
model would actually be charged — framing, separators and all — and subtracts a baseline call with
no tools. It runs no inference and bills nothing.

## Usage

```
mcp-baggage [options]

  --tools            list every tool with its own weight
  --list             show the servers found, without starting any of them
  --json             machine-readable output
  --exact            count with the Anthropic API instead of estimating

  --days <n>         days of transcripts to read for usage (default 30)
  --no-usage         skip transcripts entirely
  --window <n>       context window to measure the share against (default 200000)
  --client <name>    only servers from one client
  --all              include servers the config has switched off
  --timeout <ms>     how long a server gets to answer (default 20000)
  --cwd <path>       treat another directory as the project
```

Progress goes to stderr and the report to stdout, so `mcp-baggage --json > baggage.json` gives you
the figures and still shows you what is happening while a dozen servers start up.

## Where it looks

| Client | User | Project |
| --- | --- | --- |
| Claude Code | `~/.claude.json` | `.mcp.json` |
| Cursor | `~/.cursor/mcp.json` | `.cursor/mcp.json` |
| VS Code | — | `.vscode/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | — |
| Codex | `~/.codex/config.toml` | — |

Both transports are spoken: stdio, where the server is a process to spawn, and streamable HTTP,
where it is a URL. A server that cannot be reached is a row in the table with its own error, not a
failed run — and it is left out of the total rather than quietly counted as zero.

Usage counts come from Claude Code's transcripts, because it is the only client that keeps them in a
documented place. With no transcripts, the `used` column reads `—`. **Unknown is never printed as
zero**, and a tool that was never measured is never called waste.

## In a script

The same figures, without the table:

```js
import { scan } from 'mcp-baggage';

const { tokens, servers } = await scan();
if (tokens > 15_000) {
  console.error(`MCP tool definitions are ${tokens} tokens; budget is 15000`);
  process.exit(1);
}
```

## Install

```bash
npx mcp-baggage          # no install
npm i -g mcp-baggage     # or keep it around
```

Node 20.10 or newer. No dependencies.

---

MIT © [mtalhasahin](https://github.com/mtalhasahin)

/**
 * The command.
 *
 * Runs with no arguments and no configuration: find the configs, ask every
 * server what it carries, read the transcripts for what was used, print one
 * table. Everything else is a flag for a narrower question.
 *
 * Progress goes to stderr and the report to stdout, so `mcp-baggage > out.txt`
 * keeps the report and still shows the person what is happening while a dozen
 * servers start up.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { discover } from './config.ts';
import { exactly } from './exact.ts';
import { DEFAULT_TIMEOUT, inspectAll } from './mcp.ts';
import { asJson, breakdown, DEFAULT_WINDOW, report } from './report.ts';
import { DEFAULT_DAYS, lookup, readUsage } from './usage.ts';
import { heaviestFirst, weigh } from './weigh.ts';
import type { Inventory } from './types.ts';

/**
 * The version, read from the manifest rather than written down twice.
 *
 * It was a constant here until a release proved why that is a bad idea:
 * `npm version` bumps package.json and nothing else, so a published 0.1.1
 * would introduce itself as 0.1.0. One copy, read at startup — from
 * ../package.json, which is the manifest whether this file is running from
 * src/ or from the published dist/.
 */
const VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

const HELP = `mcp-baggage ${VERSION}

  What each MCP server carries into your context window, and how much of it
  you actually use.

  mcp-baggage [options]

  --tools            list every tool with its own weight
  --list             show the servers found, without starting any of them
  --json             machine-readable output
  --exact            count with the Anthropic API instead of estimating
                     (needs ANTHROPIC_API_KEY; bills nothing)

  --days <n>         days of transcripts to read for usage (default ${DEFAULT_DAYS})
  --no-usage         skip transcripts entirely
  --window <n>       context window to measure the share against (default ${DEFAULT_WINDOW})
  --client <name>    only servers from one client: claude-code, cursor, codex, vscode, windsurf
  --all              include servers the config has switched off
  --timeout <ms>     how long a server gets to answer (default ${DEFAULT_TIMEOUT})
  --cwd <path>       treat another directory as the project
  --version, --help
`;

type Options = {
  tools: boolean;
  list: boolean;
  json: boolean;
  exact: boolean;
  usage: boolean;
  all: boolean;
  days: number;
  window: number;
  timeout: number;
  client?: string;
  cwd: string;
};

/** Flags, with the errors a person can act on rather than a stack trace. */
export function parseArgs(argv: readonly string[]): Options | { help: true } | { version: true } | { error: string } {
  const options: Options = {
    tools: false,
    list: false,
    json: false,
    exact: false,
    usage: true,
    all: false,
    days: DEFAULT_DAYS,
    window: DEFAULT_WINDOW,
    timeout: DEFAULT_TIMEOUT,
    cwd: process.cwd(),
  };

  const number = (raw: string | undefined, flag: string): number | string => {
    const n = Number(raw);
    return raw !== undefined && Number.isFinite(n) && n > 0 ? n : `${flag} needs a positive number`;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const next = argv[i + 1];

    switch (arg) {
      case '--help':
      case '-h':
        return { help: true };
      case '--version':
      case '-v':
        return { version: true };
      case '--tools':
        options.tools = true;
        break;
      case '--list':
        options.list = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--exact':
        options.exact = true;
        break;
      case '--no-usage':
        options.usage = false;
        break;
      case '--all':
        options.all = true;
        break;
      case '--days':
      case '--window':
      case '--timeout': {
        const value = number(next, arg);
        if (typeof value === 'string') return { error: value };
        if (arg === '--days') options.days = value;
        if (arg === '--window') options.window = value;
        if (arg === '--timeout') options.timeout = value;
        i++;
        break;
      }
      case '--client':
        if (!next) return { error: '--client needs a name' };
        options.client = next;
        i++;
        break;
      case '--cwd':
        if (!next) return { error: '--cwd needs a path' };
        options.cwd = next;
        i++;
        break;
      default:
        return { error: `unknown option: ${arg}` };
    }
  }
  return options;
}

const out = (lines: readonly string[]): void => {
  process.stdout.write(`${lines.join('\n')}\n`);
};
const note = (text: string): void => {
  if (process.stderr.isTTY) process.stderr.write(`${text}\n`);
};

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ('help' in parsed) {
    process.stdout.write(HELP);
    return 0;
  }
  if ('version' in parsed) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n\nmcp-baggage --help\n`);
    return 2;
  }
  const options = parsed;

  const { specs, files } = await discover(options.cwd);
  const wanted = specs
    .filter((s) => options.all || s.enabled)
    .filter((s) => !options.client || s.carriedBy.includes(options.client));

  if (wanted.length === 0) {
    out([
      specs.length === 0
        ? 'no MCP servers found in any config on this machine'
        : `no servers match — ${specs.length} found, all filtered out`,
      '',
      files.length ? `looked in:\n${files.map((f) => `  ${f}`).join('\n')}` : 'looked in the usual places and found no config',
    ]);
    return 0;
  }

  if (options.list) {
    out([
      `${wanted.length} server${wanted.length === 1 ? '' : 's'} in ${files.length} config${files.length === 1 ? '' : 's'}`,
      '',
      ...wanted.map(
        (s) =>
          `  ${s.name.padEnd(20).slice(0, 20)} ${s.transport.padEnd(6)} ${s.carriedBy.join(', ').padEnd(24)} ${s.enabled ? '' : '(switched off) '}${s.source}`,
      ),
    ]);
    return 0;
  }

  note(`asking ${wanted.length} server${wanted.length === 1 ? '' : 's'} what they carry…`);

  let done = 0;
  const inventories: Inventory[] = await inspectAll(wanted, {
    timeout: options.timeout,
    onDone: (inv) => {
      done++;
      const what = inv.error ? `failed: ${inv.error}` : `${inv.tools.length} tools`;
      note(`  [${done}/${wanted.length}] ${inv.server.name} — ${what}`);
    },
  });

  const usage = options.usage ? await readUsage(options.days) : null;
  if (options.usage && !usage) note('no Claude Code transcripts found — usage is left unknown');

  let exactTokens: Map<string, number> | null = null;
  if (options.exact) {
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      process.stderr.write('--exact needs ANTHROPIC_API_KEY in the environment\n');
      return 2;
    }
    note('counting with the API…');
    try {
      exactTokens = await exactly(inventories, apiKey);
    } catch (e) {
      process.stderr.write(`exact count failed, falling back to the estimate: ${e instanceof Error ? e.message : e}\n`);
    }
  }

  const callsOf = lookup(usage);
  const weighed = heaviestFirst(
    inventories.map((inv) => {
      const server = weigh(inv, callsOf);
      const exact = exactTokens?.get(inv.server.name);
      return exact === undefined ? server : { ...server, tokens: exact };
    }),
  );

  if (options.json) {
    out([JSON.stringify(asJson(weighed, options.window, exactTokens !== null), null, 2)]);
    return 0;
  }

  note('');
  out([
    ...report(weighed, {
      window: options.window,
      days: usage ? usage.days : null,
      home: homedir(),
      exact: exactTokens !== null,
    }),
    ...(options.tools ? breakdown(weighed) : []),
  ]);

  return weighed.every((s) => s.error) ? 1 : 0;
}

/**
 * Which tools anyone actually called.
 *
 * The token cost of a tool definition is paid on every request whether or not
 * the tool is ever used, and that is the whole argument of this program — but
 * it is only an argument once you can see the other half of the ledger. So the
 * session transcripts are read for `tool_use` blocks, and each MCP tool gets a
 * count of the times it was reached for.
 *
 * Only Claude Code keeps transcripts in a documented place, so only its
 * sessions are read. When there are none, every count is `null` — unknown,
 * which the report is careful never to print as zero.
 */

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

/** What the transcripts said, or nothing at all. */
export type Usage = {
  /** Qualified tool name (`mcp__server__tool`) to times called. */
  calls: Map<string, number>;
  /** Transcript files read. */
  sessions: number;
  /** How far back the read went, in days. */
  days: number;
};

/** How many days of transcripts to read by default. */
export const DEFAULT_DAYS = 30;

/**
 * A tool call, from one line of a transcript.
 *
 * Exported for its own sake: the line is a whole assistant turn and can be
 * megabytes of text, so it is only parsed when the marker is present, and
 * `tool_use` blocks are the only thing taken from it. A `tool_result` echoing
 * the same name must not count as a second call.
 */
export function callsInLine(line: string): string[] {
  if (!line.includes('mcp__')) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }

  const found: string[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 8 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    if (record['type'] === 'tool_use' && typeof record['name'] === 'string' && record['name'].startsWith('mcp__')) {
      found.push(record['name']);
    }
    for (const value of Object.values(record)) walk(value, depth + 1);
  };
  walk(parsed, 0);
  return found;
}

/** Every `.jsonl` under a directory, one level of nesting or ten. */
async function transcripts(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
      .map((e) => join(e.parentPath ?? root, e.name));
  } catch {
    return [];
  }
}

/**
 * Read the transcripts and count the calls.
 *
 * Files untouched since the cutoff are skipped by their timestamp rather than
 * opened — a year of sessions is a lot of lines, and the last month is what a
 * decision about today's config rests on.
 */
export async function readUsage(days = DEFAULT_DAYS, home = homedir()): Promise<Usage | null> {
  const files = await transcripts(join(home, '.claude', 'projects'));
  if (files.length === 0) return null;

  const cutoff = Date.now() - days * 86_400_000;
  const calls = new Map<string, number>();
  let sessions = 0;

  for (const file of files) {
    try {
      const info = await stat(file);
      if (info.mtimeMs < cutoff) continue;
    } catch {
      continue;
    }
    sessions++;

    try {
      const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
      for await (const line of lines) {
        for (const name of callsInLine(line)) calls.set(name, (calls.get(name) ?? 0) + 1);
      }
    } catch {
      // A half-written transcript from a live session; what was read still counts.
    }
  }

  return { calls, sessions, days };
}

/** A lookup that answers `null` — unknown — rather than zero when nothing was read. */
export function lookup(usage: Usage | null): (qualified: string) => number | null {
  if (!usage) return () => null;
  return (qualified) => usage.calls.get(qualified) ?? 0;
}

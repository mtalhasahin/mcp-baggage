/**
 * Just enough TOML to read Codex's config.  [PURE]
 *
 * Codex keeps its servers in `~/.codex/config.toml`, and a dependency would be
 * a poor trade for the handful of shapes that file actually uses: table
 * headers, strings, integers, booleans, string arrays and inline tables. What
 * this cannot parse it skips rather than guesses at, and an unreadable file
 * costs one client, not the run.
 */

type Value = string | number | boolean | Value[] | Record<string, unknown>;

function parseValue(raw: string): Value | undefined {
  const text = raw.trim();
  if (!text) return undefined;

  if (text.startsWith('"')) return unquote(text, '"');
  if (text.startsWith("'")) return unquote(text, "'");
  if (text === 'true') return true;
  if (text === 'false') return false;

  if (text.startsWith('[')) {
    const inner = text.slice(1, text.endsWith(']') ? -1 : undefined);
    return splitTop(inner).map(parseValue).filter((v): v is Value => v !== undefined);
  }
  if (text.startsWith('{')) {
    const inner = text.slice(1, text.endsWith('}') ? -1 : undefined);
    const table: Record<string, unknown> = {};
    for (const pair of splitTop(inner)) {
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const value = parseValue(pair.slice(eq + 1));
      if (value !== undefined) table[key(pair.slice(0, eq))] = value;
    }
    return table;
  }

  const n = Number(text);
  return Number.isFinite(n) ? n : text;
}

function unquote(text: string, quote: string): string {
  const end = text.indexOf(quote, 1);
  const body = end === -1 ? text.slice(1) : text.slice(1, end);
  return quote === '"' ? body.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c)) : body;
}

const key = (raw: string): string => raw.trim().replace(/^["']|["']$/g, '');

/** Splits on commas that are not inside a string, an array or an inline table. */
function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quote) {
      if (c === quote && text[i - 1] !== '\\') quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Splits a dotted table header into its segments, respecting quotes. */
function path(header: string): string[] {
  return splitDots(header).map(key);
}

function splitDots(text: string): string[] {
  const parts: string[] = [];
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '.') {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** The whole file, as nested plain objects. Arrays of tables are not supported. */
export function parseToml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let table = root;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed.startsWith('[')) {
      const header = trimmed.slice(1, trimmed.indexOf(']') === -1 ? undefined : trimmed.indexOf(']'));
      if (header.startsWith('[')) continue; // array of tables: not needed here
      table = root;
      for (const segment of path(header)) {
        const next = table[segment];
        if (next && typeof next === 'object' && !Array.isArray(next)) table = next as Record<string, unknown>;
        else table = (table[segment] = {}) as Record<string, unknown>;
      }
      continue;
    }

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const value = parseValue(stripComment(trimmed.slice(eq + 1)));
    if (value !== undefined) table[key(trimmed.slice(0, eq))] = value;
  }
  return root;
}

/** Drops a trailing `# comment`, unless the `#` is inside a string. */
function stripComment(text: string): string {
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quote) {
      if (c === quote && text[i - 1] !== '\\') quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') return text.slice(0, i);
  }
  return text;
}

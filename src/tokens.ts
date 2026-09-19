/**
 * How many tokens a piece of text is worth.  [PURE]
 *
 * There is no public tokenizer for Claude, so this is an estimate and says so
 * everywhere it is shown. It is not `length / 4`: tool definitions are JSON,
 * and JSON is mostly punctuation, indentation and short identifiers, which
 * that ratio gets wrong in both directions at once — it under-counts braces
 * and over-counts indentation.
 *
 * Instead the text is cut into runs of one kind of character and each run is
 * priced the way a byte-pair tokenizer is known to treat it: words in pieces
 * of about five characters, digits in threes, adjacent punctuation paired up,
 * a leading space absorbed into the word after it.
 *
 * That is a model of a tokenizer, not the tokenizer, and it has not been
 * calibrated against the real one — so it is called an estimate everywhere it
 * is shown, and it is good for the question it is for: which of these servers
 * is the big one. When the figure itself has to be right, `--exact` asks the
 * API (see `exact.ts`) and nothing in this file is used.
 */

/** Letters, digits, whitespace, everything else — each in runs. */
const RUNS = /[A-Za-z]+|[0-9]+|\s+|[^\sA-Za-z0-9]+/g;

/**
 * One run's worth of tokens.
 *
 * - Letters: common words and identifiers come out around five characters a
 *   token once `camelCase` boundaries and word-piece splits are averaged in.
 * - Digits: tokenizers group them in threes.
 * - Whitespace: a lone space is absorbed into the word that follows it and is
 *   free; a newline is its own token, and the indentation after it packs into
 *   roughly four characters a token.
 * - Punctuation: adjacent marks pair up — `{"`, `":`, `",` are each one token —
 *   so a run costs about half its length, never less than one.
 */
function runTokens(run: string): number {
  const first = run[0] as string;

  if (/\s/.test(first)) {
    const newlines = (run.match(/\n/g) ?? []).length;
    if (newlines === 0) return run.length === 1 ? 0 : Math.ceil(run.length / 4);
    return newlines + Math.ceil((run.length - newlines) / 4);
  }
  if (first >= '0' && first <= '9') return Math.ceil(run.length / 3);
  if (/[A-Za-z]/.test(first)) return Math.max(1, Math.round(run.length / 5));
  return Math.max(1, Math.ceil(run.length / 2));
}

/** The estimate, for any text. */
export function estimate(text: string): number {
  if (!text) return 0;
  let total = 0;
  for (const run of text.match(RUNS) ?? []) total += runTokens(run);
  return total;
}

/**
 * What a client adds around each tool definition it sends.
 *
 * The name and schema are counted from the text itself; this is the framing
 * that does not appear in the JSON — the wrapper the API puts each tool in.
 * It is small and flat, and it is here as a named constant rather than buried
 * in an expression so that it can be argued with.
 */
export const TOOL_FRAMING = 8;

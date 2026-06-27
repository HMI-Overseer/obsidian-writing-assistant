/**
 * Full-content find-and-replace engine for `replace_in_vault`.
 *
 * Pure (no Obsidian, no disk): operates over an injected file list + a
 * `readContent` probe, so it is unit-testable with no vault. It replaces *every*
 * occurrence of a literal `search` across each file's whole content, unlike the
 * per-line snippet matcher in `search_content` (a different granularity, kept
 * separate on purpose, lexical search shows one line; a rename rewrites the file).
 *
 * The composite `replaceInVault` op carries the precomputed per-file content this
 * produces, so the model never authors file bodies and the review shows exactly
 * what will be written.
 */

/** A literal find/replace request, the model-supplied flags defaulted by the caller. */
export interface ReplaceOptions {
  /** Literal text to find (never a regex, escaped before matching). */
  search: string;
  /** Replacement inserted verbatim ($&, $1, … are literal, not special). */
  replace: string;
  /** Match case exactly. Defaults to false (case-insensitive). */
  caseSensitive?: boolean;
  /** Require whole-word boundaries (\b) around the match. Defaults to false. */
  wholeWord?: boolean;
}

/** One file's computed change, only produced when `count > 0`. */
export interface ReplaceFileResult {
  path: string;
  /** The file's full content with every occurrence replaced. */
  content: string;
  /** Occurrences replaced in this file (always > 0). */
  count: number;
}

/** Escape a string for safe literal use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the global matcher for `search`: the escaped literal, optionally wrapped in
 * `\b` word boundaries, always global (`g`) so every occurrence is found, and
 * case-insensitive (`i`) unless `caseSensitive`.
 */
export function buildReplaceRegex(opts: ReplaceOptions): RegExp {
  const body = escapeRegExp(opts.search);
  const pattern = opts.wholeWord ? `\\b${body}\\b` : body;
  return new RegExp(pattern, opts.caseSensitive ? "g" : "gi");
}

/**
 * Replace every occurrence of `search` in `content`. The replacement is inserted
 * through a function replacer, so any `$`-sequence in `replace` stays literal
 * rather than being interpreted as a capture-group reference. Returns the new
 * content and the number of occurrences replaced.
 */
export function applyReplacement(
  content: string,
  opts: ReplaceOptions,
): { content: string; count: number } {
  const rx = buildReplaceRegex(opts);
  const matches = content.match(rx);
  const count = matches ? matches.length : 0;
  // A function replacer returns the replacement verbatim, so any `$`-sequence in
  // `replace` ($&, $1, …) stays literal instead of being read as a capture reference.
  const next = content.replace(rx, () => opts.replace);
  return { content: next, count };
}

/**
 * Compute the replaced content for every file (from `files`) that contains
 * `search`. Files with no match, and paths `readContent` cannot read (null), are
 * omitted, so the result is exactly the set of files the op will rewrite.
 */
export function findReplaceTargets(
  files: string[],
  readContent: (path: string) => string | null,
  opts: ReplaceOptions,
): ReplaceFileResult[] {
  const results: ReplaceFileResult[] = [];
  for (const path of files) {
    const content = readContent(path);
    if (content === null) continue;
    const { content: next, count } = applyReplacement(content, opts);
    if (count > 0) results.push({ path, content: next, count });
  }
  return results;
}

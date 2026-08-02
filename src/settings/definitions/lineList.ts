/**
 * The newline-delimited string list three settings rows store as an array: `vaultOpPolicy.scopes`,
 * `rag.excludePatterns`, and `knowledgeGraph.excludePatterns`.
 *
 * Written out by hand at each row until all three converted. It lives here, importing nothing from
 * `obsidian`, because that is what makes it testable at all: a transform inside a `render` callback
 * can only be exercised by faking the render machinery around it.
 *
 * The pair is a round trip in one direction only. `parseLineList` is lossy on purpose (blank lines
 * and surrounding whitespace are discarded), so `format(parse(x))` normalizes rather than restores,
 * and `parse(format(x))` is the identity for any list `parse` can produce.
 */

/** Splits a textarea's value into stored entries, dropping blank lines and trimming each. */
export function parseLineList(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Renders stored entries back into a textarea's value. */
export function formatLineList(lines: readonly string[]): string {
  return lines.join("\n");
}

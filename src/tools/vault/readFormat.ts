/**
 * Render note content with cat -n style line numbers: a right-aligned line
 * number, a tab, then the line verbatim. Line numbers give the model stable
 * anchors for navigating a long note and for matching `edit` search
 * text against the same content it just read (tool-set-review H1). Only the
 * number column is added; everything after the tab is the original line, so an
 * edit's search text must exclude the leading "N\t" prefix.
 *
 * A trailing newline yields a final empty element from split, dropped here so
 * the file's last real line is the last numbered line (matching cat -n). An
 * empty note renders as "" (there is nothing to number).
 *
 * `startLine` (1-indexed, default 1) is the file line number of the first line
 * of `content`. `read`'s section pathway passes the heading's line number so a
 * section's numbers are the *same* numbers the whole-note pathway would show for
 * those lines (tool-set-review D6's line-number-consistency condition); the
 * whole-note pathway leaves it at the default. The number column widens to the
 * largest absolute line number so an offset slice still right-aligns.
 *
 * This parameter is why `read` can merge the two pathways without reconciling
 * anything (RFC-0015 D4): they already spoke one line vocabulary.
 */
export function formatWithLineNumbers(content: string, startLine = 1): string {
  if (content === "") return "";
  const lines = content.split("\n");
  // A trailing newline produces a phantom empty final element; cat -n does not
  // number it, so neither do we.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const width = String(startLine + lines.length - 1).length;
  return lines
    .map((line, i) => `${String(startLine + i).padStart(width)}\t${line}`)
    .join("\n");
}

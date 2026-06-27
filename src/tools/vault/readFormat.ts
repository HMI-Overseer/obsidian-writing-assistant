/**
 * Render note content with cat -n style line numbers: a right-aligned line
 * number, a tab, then the line verbatim. Line numbers give the model stable
 * anchors for navigating a long note and for matching `propose_edit` search
 * text against the same content it just read (tool-set-review H1). Only the
 * number column is added; everything after the tab is the original line, so an
 * edit's search text must exclude the leading "N\t" prefix.
 *
 * A trailing newline yields a final empty element from split, dropped here so
 * the file's last real line is the last numbered line (matching cat -n). An
 * empty note renders as "" (there is nothing to number).
 *
 * Shared by read_file and, later, read_section so both speak one line
 * vocabulary (tool-set-review D6).
 */
export function formatWithLineNumbers(content: string): string {
  if (content === "") return "";
  const lines = content.split("\n");
  // A trailing newline produces a phantom empty final element; cat -n does not
  // number it, so neither do we.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const width = String(lines.length).length;
  return lines.map((line, i) => `${String(i + 1).padStart(width)}\t${line}`).join("\n");
}

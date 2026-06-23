/**
 * End-of-line handling for the edit pipeline.
 *
 * The diff engine and its renderers work entirely in LF-space: the model speaks
 * `\n`, and the in-note CM6 overlay's document is LF-only regardless of the file's
 * on-disk convention. A Windows-authored note, though, is read back from the vault
 * with `\r\n`. So `\r` is an *encoding* difference, never a *semantic* one, and the
 * single place it should be reconciled is the file-write boundary
 * ({@link ../editing/documentApplicator}): normalize the live content to LF, splice,
 * then re-expand to the document's prevailing EOL. This module is that boundary's
 * toolkit. (diff-engine-real-document-robustness, P1-2.)
 */

/** The newline convention a document uses when written back to disk. */
export type Eol = "\n" | "\r\n";

/**
 * Detect a document's prevailing end-of-line sequence. CRLF wins when the document
 * has at least one CRLF and CRLF is at least as common as lone LF, so a re-expanded
 * write matches the file's majority rather than introducing a third state. A document
 * with no newlines (or only lone LF) is LF.
 */
export function detectEol(text: string): Eol {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const totalLf = (text.match(/\n/g) ?? []).length;
  const loneLf = totalLf - crlf;
  return crlf > 0 && crlf >= loneLf ? "\r\n" : "\n";
}

/** Normalize any mix of CRLF / lone CR / LF to LF-only (the engine's convention). */
export function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Re-expand LF-only text to the given EOL convention. The input must already be
 * LF-only (run it through {@link toLf} first), otherwise an existing `\r\n` would
 * double-expand to `\r\r\n`.
 */
export function fromLf(lfText: string, eol: Eol): string {
  return eol === "\r\n" ? lfText.replace(/\n/g, "\r\n") : lfText;
}

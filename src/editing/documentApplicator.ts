import type { App } from "obsidian";
import type { DiffHunk } from "./editTypes";
import { detectEol, fromLf, toLf } from "./lineEndings";

/**
 * Maximum character drift allowed between the originally resolved offset
 * and the live-document offset before a hunk is skipped. Prevents applying
 * edits to the wrong part of a significantly changed document.
 */
const MAX_OFFSET_DRIFT = 500;

export interface LiveApplyResult {
  preContent: string;
  postContent: string;
  appliedHunkIds: string[];
  /** Character offset in postContent where each hunk's replacement was inserted, keyed by hunk ID. */
  appliedOffsets: Map<string, number>;
}

/**
 * Apply hunks to the current document by searching for each hunk's text.
 *
 * Uses `indexOf` to locate each search block in the live document,
 * making it safe for incremental (one-at-a-time) applies without
 * requiring the document to match the original snapshot.
 */
export async function applyHunksLive(
  app: App,
  targetFilePath: string,
  hunks: DiffHunk[]
): Promise<LiveApplyResult> {
  const file = app.vault.getFileByPath(targetFilePath);
  if (!file) throw new Error(`File not found: ${targetFilePath}`);

  // Sort by descending offset so earlier positions stay valid after later splices
  const sortedHunks = [...hunks]
    .filter((h) => h.resolvedEdit.confidence > 0)
    .sort((a, b) => b.resolvedEdit.matchOffset - a.resolvedEdit.matchOffset);

  let preContent = "";
  const appliedIds: string[] = [];
  const appliedOffsets = new Map<string, number>();

  await app.vault.process(file, (currentContent) => {
    preContent = currentContent;

    // Resolve every splice in LF-space (the convention matchedText/replaceText and the
    // resolved offsets use), then re-expand to the file's prevailing EOL on write, so a
    // CRLF note stays pure CRLF instead of mixing endings (P1-2).
    const eol = detectEol(currentContent);
    let result = toLf(currentContent);

    for (const hunk of sortedHunks) {
      // Use matchedText (the actual text found in the document) rather than
      // searchText (what the model provided), these can differ when the match
      // was whitespace-normalized or fuzzy.
      const matchedText = hunk.resolvedEdit.matchedText;
      const replaceText = toLf(hunk.resolvedEdit.editBlock.replaceText);
      const idx = result.indexOf(matchedText);

      if (idx !== -1) {
        // Guard against applying to the wrong location if the document drifted significantly
        const expectedOffset = hunk.resolvedEdit.matchOffset;
        if (expectedOffset >= 0 && Math.abs(idx - expectedOffset) > MAX_OFFSET_DRIFT) {
          continue;
        }

        result = result.slice(0, idx) + replaceText + result.slice(idx + matchedText.length);
        appliedIds.push(hunk.id);
        appliedOffsets.set(hunk.id, idx);
      }
    }

    return fromLf(result, eol);
  });

  const postContent = appliedIds.length > 0 ? await app.vault.read(file) : preContent;

  return { preContent, postContent, appliedHunkIds: appliedIds, appliedOffsets };
}

export interface LiveUndoResult {
  /** True when the replacement was found and reversed. */
  undone: boolean;
  /** The document content after reversal, or null when the undo could not be performed. */
  restoredContent: string | null;
}

/**
 * Reverse a single applied hunk: find the replacement text in the live document
 * and restore the original matched text in its place.
 *
 * Re-anchors before mutating, prefers the tracked offset where the replacement
 * was inserted (accurate even when identical text appears elsewhere), falling
 * back to `indexOf`. Returns `undone: false` without modifying the file when the
 * replacement can no longer be located (the document drifted past recovery).
 *
 * Uses `matchedText` (what was actually in the document) rather than `searchText`
 * (what the model provided), these differ on whitespace-normalized matches.
 */
export async function undoHunkLive(
  app: App,
  targetFilePath: string,
  hunk: DiffHunk,
  trackedOffset?: number
): Promise<LiveUndoResult> {
  const file = app.vault.getFileByPath(targetFilePath);
  if (!file) return { undone: false, restoredContent: null };

  // matchedText/replaceText and the tracked offset are LF-space; reverse the splice
  // there, then re-expand to the file's prevailing EOL on write (mirrors applyHunksLive).
  const replaceText = toLf(hunk.resolvedEdit.editBlock.replaceText);
  const originalText = hunk.resolvedEdit.matchedText;

  let undone = false;
  let restored: string | null = null;

  await app.vault.process(file, (currentContent) => {
    const eol = detectEol(currentContent);
    const lfContent = toLf(currentContent);

    // Prefer the tracked offset for accuracy; fall back to indexOf.
    let idx = -1;
    if (
      trackedOffset !== undefined &&
      lfContent.slice(trackedOffset, trackedOffset + replaceText.length) === replaceText
    ) {
      idx = trackedOffset;
    } else {
      idx = lfContent.indexOf(replaceText);
    }

    if (idx === -1) return currentContent;

    restored = fromLf(
      lfContent.slice(0, idx) + originalText + lfContent.slice(idx + replaceText.length),
      eol
    );
    undone = true;
    return restored;
  });

  return { undone, restoredContent: restored };
}

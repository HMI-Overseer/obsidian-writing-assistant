import type { App } from "obsidian";
import type { DiffHunk } from "./editTypes";

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
    let result = currentContent;

    for (const hunk of sortedHunks) {
      const searchText = hunk.resolvedEdit.editBlock.searchText;
      const replaceText = hunk.resolvedEdit.editBlock.replaceText;
      const idx = result.indexOf(searchText);

      if (idx !== -1) {
        // Guard against applying to the wrong location if the document drifted significantly
        const expectedOffset = hunk.resolvedEdit.matchOffset;
        if (expectedOffset >= 0 && Math.abs(idx - expectedOffset) > MAX_OFFSET_DRIFT) {
          continue;
        }

        result = result.slice(0, idx) + replaceText + result.slice(idx + searchText.length);
        appliedIds.push(hunk.id);
        appliedOffsets.set(hunk.id, idx);
      }
    }

    return result;
  });

  const postContent = appliedIds.length > 0 ? await app.vault.read(file) : preContent;

  return { preContent, postContent, appliedHunkIds: appliedIds, appliedOffsets };
}

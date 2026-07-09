/**
 * Build the always-visible diff a write_file review nests under its timeline step
 * (docs/03-decisions, docs/review/reviews 2026-07-08-edit-tool-review-display F1). Turns a
 * `create` / `overwrite` op's content into a single {@link DiffHunk} the shared
 * DiffHunkView can render, so the user sees *what will be written* before approving.
 *
 * Pure: no Obsidian, no disk (the caller supplies the current content), so it is
 * unit-testable, like the other vault-op presentation helpers in summary.ts.
 */

import type { DiffHunk } from "../editing/editTypes";

/** Context lines kept on each side of the changed region in an overwrite preview. */
const DEFAULT_CONTEXT_LINES = 3;

/**
 * A single reviewable hunk previewing a whole-file write.
 *
 * `before` is the file's current content, or `null` for a `create` (a brand-new file,
 * shown as an all-add hunk). For an `overwrite`, the common leading and trailing lines
 * are trimmed so only the differing region plus a few context lines is shown, rather
 * than the entire file rendered twice: a note whose first paragraph changed previews as
 * that paragraph, not the whole document. Scattered edits collapse into one contiguous
 * region (the DiffHunk model is a single region + context), which is the honest,
 * height-capped preview the review calls for, not a minimal multi-hunk diff.
 */
export function buildWritePreviewHunk(
  before: string | null,
  next: string,
  id: string,
  contextLines: number = DEFAULT_CONTEXT_LINES,
): DiffHunk {
  const beforeLines = before === null ? [] : before.split("\n");
  const afterLines = next.split("\n");

  // Common leading lines shared by both sides (a create has none: before is empty).
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix++;
  }

  // Common trailing lines, not overlapping the shared prefix on either side.
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] ===
      afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const removedMiddle = beforeLines.slice(prefix, beforeLines.length - suffix);
  const addedMiddle = afterLines.slice(prefix, afterLines.length - suffix);

  const contextBefore = beforeLines.slice(Math.max(0, prefix - contextLines), prefix);
  const contextAfter = beforeLines.slice(
    beforeLines.length - suffix,
    beforeLines.length - suffix + contextLines,
  );

  const isCreate = before === null;
  const startLine = isCreate ? 1 : prefix + 1;
  // Display/positioning only: a create spans the new file; an overwrite ends at the
  // last removed line (clamped so a pure insertion never reads as a backwards range).
  const endLine = isCreate
    ? Math.max(1, afterLines.length)
    : Math.max(startLine, prefix + removedMiddle.length);

  const searchText = removedMiddle.join("\n");
  const replaceText = addedMiddle.join("\n");

  return {
    id,
    status: "pending",
    resolvedEdit: {
      id,
      editBlock: { id, searchText, replaceText, rawBlock: "" },
      matchOffset: 0,
      matchLength: searchText.length,
      matchedText: searchText,
      startLine,
      endLine,
      contextBefore,
      contextAfter,
      confidence: 1,
      matchType: "exact",
    },
  };
}

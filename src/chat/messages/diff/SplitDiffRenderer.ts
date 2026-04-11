import type { DiffHunk } from "../../../editing/editTypes";
import type { DiffSegment } from "../../../editing/wordDiff";
import { computeWordDiff, renderSegments } from "../../../editing/wordDiff";

interface SideCellData {
  text: string;
  lineNumber?: number;
  type: "context" | "removed" | "added";
  segments?: DiffSegment[];
}

/**
 * Renders a diff hunk in side-by-side (split) mode.
 */
export function renderSplitBody(bodyEl: HTMLElement, hunk: DiffHunk): void {
  const { resolvedEdit } = hunk;

  // Context before
  if (resolvedEdit.contextBefore.length > 0) {
    const startNum = resolvedEdit.startLine - resolvedEdit.contextBefore.length;
    for (let i = 0; i < resolvedEdit.contextBefore.length; i++) {
      const text = resolvedEdit.contextBefore[i];
      renderRow(bodyEl, {
        left: { text, lineNumber: startNum + i, type: "context" },
        right: { text, lineNumber: startNum + i, type: "context" },
      });
    }
  }

  // Changed lines
  const removedLines = resolvedEdit.editBlock.searchText.split("\n");
  const addedLines = resolvedEdit.editBlock.replaceText.split("\n");
  const hasAdded = addedLines.length > 0 && !(addedLines.length === 1 && addedLines[0] === "");
  const pairedCount = hasAdded ? Math.min(removedLines.length, addedLines.length) : 0;
  const maxCount = Math.max(removedLines.length, hasAdded ? addedLines.length : 0);

  for (let i = 0; i < maxCount; i++) {
    const hasRemoved = i < removedLines.length;
    const hasAddedLine = hasAdded && i < addedLines.length;

    let leftSegments: DiffSegment[] | undefined;
    let rightSegments: DiffSegment[] | undefined;
    if (i < pairedCount) {
      const wd = computeWordDiff(removedLines[i], addedLines[i]);
      leftSegments = wd.removed;
      rightSegments = wd.added;
    }

    renderRow(bodyEl, {
      left: hasRemoved
        ? { text: removedLines[i], lineNumber: resolvedEdit.startLine + i, type: "removed", segments: leftSegments }
        : null,
      right: hasAddedLine
        ? { text: addedLines[i], type: "added", segments: rightSegments }
        : null,
    });
  }

  // Context after
  if (resolvedEdit.contextAfter.length > 0) {
    const startNum = resolvedEdit.endLine + 1;
    for (let i = 0; i < resolvedEdit.contextAfter.length; i++) {
      const text = resolvedEdit.contextAfter[i];
      renderRow(bodyEl, {
        left: { text, lineNumber: startNum + i, type: "context" },
        right: { text, lineNumber: startNum + i, type: "context" },
      });
    }
  }
}

function renderRow(
  parent: HTMLElement,
  sides: { left: SideCellData | null; right: SideCellData | null },
): void {
  const rowEl = parent.createDiv({ cls: "lmsa-chat-window-diff-row" });
  renderSideCell(rowEl, sides.left, "left");
  renderSideCell(rowEl, sides.right, "right");
}

function renderSideCell(
  row: HTMLElement,
  data: SideCellData | null,
  side: "left" | "right",
): void {
  if (!data) {
    row.createDiv({ cls: `lmsa-chat-window-diff-side lmsa-chat-window-diff-side--${side} lmsa-chat-window-diff-side--empty` });
    return;
  }

  const cellEl = row.createDiv({
    cls: `lmsa-chat-window-diff-side lmsa-chat-window-diff-side--${side} lmsa-chat-window-diff-line--${data.type}`,
  });

  const gutterEl = cellEl.createSpan({ cls: "lmsa-chat-window-diff-gutter" });
  if (data.lineNumber !== undefined) {
    gutterEl.setText(String(data.lineNumber));
  }

  const textEl = cellEl.createSpan({ cls: "lmsa-chat-window-diff-text" });

  if (data.segments && data.segments.length > 0) {
    renderSegments(textEl, data.segments);
  } else {
    textEl.setText(data.text || " ");
  }
}

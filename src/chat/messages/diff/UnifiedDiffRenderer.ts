import type { DiffHunk } from "../../../editing/editTypes";
import type { DiffSegment } from "../../../editing/wordDiff";
import { computeWordDiff, renderSegments } from "../../../editing/wordDiff";

/**
 * Renders a diff hunk in unified (single-column) mode.
 */
export function renderUnifiedBody(bodyEl: HTMLElement, hunk: DiffHunk): void {
  const { resolvedEdit } = hunk;

  if (resolvedEdit.contextBefore.length > 0) {
    renderLines(bodyEl, resolvedEdit.contextBefore, "context", resolvedEdit.startLine - resolvedEdit.contextBefore.length);
  }

  const removedLines = resolvedEdit.editBlock.searchText.split("\n");
  const addedLines = resolvedEdit.editBlock.replaceText.split("\n");
  const hasAdded = addedLines.length > 0 && !(addedLines.length === 1 && addedLines[0] === "");
  const pairedCount = hasAdded ? Math.min(removedLines.length, addedLines.length) : 0;

  for (let i = 0; i < pairedCount; i++) {
    const segments = computeWordDiff(removedLines[i], addedLines[i]);
    const lineNum = resolvedEdit.startLine + i;
    renderHighlightedLine(bodyEl, segments.removed, "removed", lineNum);
    renderHighlightedLine(bodyEl, segments.added, "added");
  }

  if (removedLines.length > pairedCount) {
    renderLines(bodyEl, removedLines.slice(pairedCount), "removed", resolvedEdit.startLine + pairedCount);
  }

  if (hasAdded && addedLines.length > pairedCount) {
    renderLines(bodyEl, addedLines.slice(pairedCount), "added");
  }

  if (resolvedEdit.contextAfter.length > 0) {
    renderLines(bodyEl, resolvedEdit.contextAfter, "context", resolvedEdit.endLine + 1);
  }
}

function renderLines(
  parent: HTMLElement,
  lines: string[],
  type: "context" | "removed" | "added",
  startLineNumber?: number,
): void {
  const prefix = type === "removed" ? "−" : type === "added" ? "+" : " ";

  for (let i = 0; i < lines.length; i++) {
    const lineEl = parent.createDiv({ cls: `lmsa-chat-window-diff-line lmsa-chat-window-diff-line--${type}` });

    const gutterEl = lineEl.createSpan({ cls: "lmsa-chat-window-diff-gutter" });
    if (startLineNumber !== undefined) {
      gutterEl.setText(String(startLineNumber + i));
    }

    const prefixEl = lineEl.createSpan({ cls: "lmsa-chat-window-diff-prefix" });
    prefixEl.setText(prefix);

    const textEl = lineEl.createSpan({ cls: "lmsa-chat-window-diff-text" });
    textEl.setText(lines[i] || " ");
  }
}

function renderHighlightedLine(
  parent: HTMLElement,
  segments: DiffSegment[],
  type: "removed" | "added",
  lineNumber?: number,
): void {
  const prefix = type === "removed" ? "−" : "+";
  const lineEl = parent.createDiv({ cls: `lmsa-chat-window-diff-line lmsa-chat-window-diff-line--${type}` });

  const gutterEl = lineEl.createSpan({ cls: "lmsa-chat-window-diff-gutter" });
  if (lineNumber !== undefined) {
    gutterEl.setText(String(lineNumber));
  }

  const prefixEl = lineEl.createSpan({ cls: "lmsa-chat-window-diff-prefix" });
  prefixEl.setText(prefix);

  const textEl = lineEl.createSpan({ cls: "lmsa-chat-window-diff-text" });
  renderSegments(textEl, segments);
}

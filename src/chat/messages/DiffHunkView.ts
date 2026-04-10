import { setIcon } from "obsidian";
import type { DiffHunk, EditStatus } from "../../editing/editTypes";

export type DiffMode = "unified" | "split";

export type DiffHunkCallbacks = {
  onAccept: (hunkId: string) => void;
  onReject: (hunkId: string) => void;
  onUndo: (hunkId: string) => void;
  onModeChange: (mode: DiffMode) => void;
};

/**
 * Renders a single diff hunk with context lines, removed/added lines,
 * and accept/reject controls. Supports both unified and side-by-side modes.
 */
export class DiffHunkView {
  readonly containerEl: HTMLElement;

  private statusEl: HTMLElement;
  private actionsEl: HTMLElement;
  private acceptBtn: HTMLButtonElement;
  private rejectBtn: HTMLButtonElement;
  private splitBtn: HTMLButtonElement | null = null;
  private unifiedBtn: HTMLButtonElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private diffMode: DiffMode;

  constructor(
    parent: HTMLElement,
    private readonly hunk: DiffHunk,
    private readonly callbacks: DiffHunkCallbacks,
    initialMode: DiffMode = "split"
  ) {
    this.diffMode = initialMode;
    this.containerEl = parent.createDiv({ cls: "lmsa-chat-window-diff-hunk" });
    this.containerEl.dataset.status = hunk.status;
    this.containerEl.dataset.hunkId = hunk.id;

    const { statusEl, actionsEl, acceptBtn, rejectBtn } = this.renderHeader();
    this.statusEl = statusEl;
    this.actionsEl = actionsEl;
    this.acceptBtn = acceptBtn;
    this.rejectBtn = rejectBtn;

    this.renderBody();
  }

  /** Switch between unified and side-by-side display. */
  setDiffMode(mode: DiffMode): void {
    if (mode === this.diffMode) return;
    this.diffMode = mode;
    this.splitBtn?.toggleClass("is-active", mode === "split");
    this.unifiedBtn?.toggleClass("is-active", mode === "unified");
    this.renderBody();
  }

  /** Update the hunk's visual status without re-rendering the body. */
  setStatus(status: EditStatus): void {
    this.containerEl.dataset.status = status;
    this.updateStatusLabel(status);
  }

  /** Transition the hunk to a post-apply "completed" state (no undo). */
  setApplied(wasApplied: boolean): void {
    this.containerEl.dataset.status = wasApplied ? "applied" : "skipped";
    this.actionsEl.empty();

    this.statusEl.empty();
    this.statusEl.addClass("lmsa-chat-window-diff-hunk-badge");
    if (wasApplied) {
      this.statusEl.addClass("lmsa-chat-window-diff-hunk-badge--applied");
      this.statusEl.setText("Applied");
    } else {
      this.statusEl.addClass("lmsa-chat-window-diff-hunk-badge--skipped");
      this.statusEl.setText("Skipped");
    }
  }

  /** Transition to applied state with an undo button. */
  setAppliedWithUndo(): void {
    this.containerEl.dataset.status = "applied";
    this.actionsEl.empty();

    this.statusEl.empty();
    this.statusEl.addClass("lmsa-chat-window-diff-hunk-badge", "lmsa-chat-window-diff-hunk-badge--applied");
    this.statusEl.setText("Applied");

    // Keep mode toggle visible
    const modeGroup = this.actionsEl.createDiv({ cls: "lmsa-chat-window-btn-group" });

    this.splitBtn = modeGroup.createEl("button", {
      cls: "lmsa-chat-window-btn-group-item",
      attr: { "aria-label": "Side-by-side view" },
    });
    setIcon(this.splitBtn, "columns-2");
    this.splitBtn.toggleClass("is-active", this.diffMode === "split");
    this.splitBtn.addEventListener("click", () => this.callbacks.onModeChange("split"));

    this.unifiedBtn = modeGroup.createEl("button", {
      cls: "lmsa-chat-window-btn-group-item",
      attr: { "aria-label": "Unified view" },
    });
    setIcon(this.unifiedBtn, "rows-2");
    this.unifiedBtn.toggleClass("is-active", this.diffMode === "unified");
    this.unifiedBtn.addEventListener("click", () => this.callbacks.onModeChange("unified"));

    // Undo button
    const undoBtn = this.actionsEl.createEl("button", {
      cls: "lmsa-chat-window-diff-hunk-btn lmsa-chat-window-diff-hunk-btn--undo",
      attr: { "aria-label": "Undo this change" },
    });
    setIcon(undoBtn, "undo");
    undoBtn.createSpan({ text: "Undo" });
    undoBtn.addEventListener("click", () => this.callbacks.onUndo(this.hunk.id));
  }

  /** Reset hunk back to pending state (after undo). */
  resetToPending(): void {
    this.containerEl.dataset.status = "pending";

    this.statusEl.empty();
    this.statusEl.removeClass("lmsa-chat-window-diff-hunk-badge", "lmsa-chat-window-diff-hunk-badge--applied", "lmsa-chat-window-diff-hunk-badge--skipped");
    this.renderConfidenceLabel(this.statusEl, this.hunk.resolvedEdit.confidence);

    this.actionsEl.empty();

    // Re-render mode toggle group
    const modeGroup = this.actionsEl.createDiv({ cls: "lmsa-chat-window-btn-group" });

    this.splitBtn = modeGroup.createEl("button", {
      cls: "lmsa-chat-window-btn-group-item",
      attr: { "aria-label": "Side-by-side view" },
    });
    setIcon(this.splitBtn, "columns-2");
    this.splitBtn.toggleClass("is-active", this.diffMode === "split");
    this.splitBtn.addEventListener("click", () => this.callbacks.onModeChange("split"));

    this.unifiedBtn = modeGroup.createEl("button", {
      cls: "lmsa-chat-window-btn-group-item",
      attr: { "aria-label": "Unified view" },
    });
    setIcon(this.unifiedBtn, "rows-2");
    this.unifiedBtn.toggleClass("is-active", this.diffMode === "unified");
    this.unifiedBtn.addEventListener("click", () => this.callbacks.onModeChange("unified"));

    // Re-render review group
    const reviewGroup = this.actionsEl.createDiv({ cls: "lmsa-chat-window-btn-group" });

    this.acceptBtn = reviewGroup.createEl("button", {
      cls: "lmsa-chat-window-btn-group-item lmsa-chat-window-btn-group-item--accept",
      attr: { "aria-label": "Accept change" },
    });
    setIcon(this.acceptBtn, "check");
    this.acceptBtn.createSpan({ text: "Accept" });
    this.acceptBtn.addEventListener("click", () => this.callbacks.onAccept(this.hunk.id));

    this.rejectBtn = reviewGroup.createEl("button", {
      cls: "lmsa-chat-window-btn-group-item lmsa-chat-window-btn-group-item--reject",
      attr: { "aria-label": "Reject change" },
    });
    setIcon(this.rejectBtn, "x");
    this.rejectBtn.createSpan({ text: "Reject" });
    this.rejectBtn.addEventListener("click", () => this.callbacks.onReject(this.hunk.id));
  }

  // -----------------------------------------------------------------------
  // Header
  // -----------------------------------------------------------------------

  private renderHeader(): {
    statusEl: HTMLElement;
    actionsEl: HTMLElement;
    acceptBtn: HTMLButtonElement;
    rejectBtn: HTMLButtonElement;
  } {
    const headerEl = this.containerEl.createDiv({ cls: "lmsa-chat-window-diff-hunk-header" });

    const metaEl = headerEl.createDiv({ cls: "lmsa-chat-window-diff-hunk-meta" });

    const { startLine, endLine, confidence } = this.hunk.resolvedEdit;
    const locationText =
      startLine === endLine ? `Line ${startLine}` : `Lines ${startLine}–${endLine}`;
    metaEl.createSpan({ cls: "lmsa-chat-window-diff-hunk-location", text: locationText });

    const statusEl = metaEl.createSpan({ cls: "lmsa-chat-window-diff-hunk-confidence" });
    this.renderConfidenceLabel(statusEl, confidence);

    const actionsEl = headerEl.createDiv({ cls: "lmsa-chat-window-diff-hunk-actions" });

    // Button group 1: diff mode toggle
    const modeGroup = actionsEl.createDiv({ cls: "lmsa-chat-window-btn-group" });

    const splitBtn = modeGroup.createEl("button", {
      cls: "lmsa-chat-window-btn-group-item",
      attr: { "aria-label": "Side-by-side view" },
    });
    setIcon(splitBtn, "columns-2");
    splitBtn.toggleClass("is-active", this.diffMode === "split");
    splitBtn.addEventListener("click", () => {
      this.callbacks.onModeChange("split");
    });
    this.splitBtn = splitBtn;

    const unifiedBtn = modeGroup.createEl("button", {
      cls: "lmsa-chat-window-btn-group-item",
      attr: { "aria-label": "Unified view" },
    });
    setIcon(unifiedBtn, "rows-2");
    unifiedBtn.toggleClass("is-active", this.diffMode === "unified");
    unifiedBtn.addEventListener("click", () => {
      this.callbacks.onModeChange("unified");
    });
    this.unifiedBtn = unifiedBtn;

    // Button group 2: accept / reject
    const reviewGroup = actionsEl.createDiv({ cls: "lmsa-chat-window-btn-group" });

    const acceptBtn = reviewGroup.createEl("button", {
      cls: "lmsa-chat-window-btn-group-item lmsa-chat-window-btn-group-item--accept",
      attr: { "aria-label": "Accept change" },
    });
    setIcon(acceptBtn, "check");
    acceptBtn.createSpan({ text: "Accept" });
    acceptBtn.addEventListener("click", () => this.callbacks.onAccept(this.hunk.id));

    const rejectBtn = reviewGroup.createEl("button", {
      cls: "lmsa-chat-window-btn-group-item lmsa-chat-window-btn-group-item--reject",
      attr: { "aria-label": "Reject change" },
    });
    setIcon(rejectBtn, "x");
    rejectBtn.createSpan({ text: "Reject" });
    rejectBtn.addEventListener("click", () => this.callbacks.onReject(this.hunk.id));

    return { statusEl, actionsEl, acceptBtn, rejectBtn };
  }

  private renderConfidenceLabel(el: HTMLElement, confidence: number): void {
    if (confidence >= 1.0) {
      el.setText("Exact match");
    } else if (confidence >= 0.95) {
      el.setText("Whitespace match");
    } else if (confidence > 0) {
      el.setText(`~${Math.round(confidence * 100)}% match`);
      el.addClass("is-low-confidence");
    } else {
      el.addClass("is-no-match");
      const warnIcon = el.createSpan({ cls: "lmsa-chat-window-diff-hunk-warn-icon" });
      setIcon(warnIcon, "alert-triangle");
      el.createSpan({ text: "No match found" });
    }
  }

  private updateStatusLabel(status: EditStatus): void {
    this.acceptBtn.toggleClass("is-active", status === "accepted");
    this.rejectBtn.toggleClass("is-active", status === "rejected");
  }

  // -----------------------------------------------------------------------
  // Body — delegates to unified or side-by-side renderer
  // -----------------------------------------------------------------------

  private renderBody(): void {
    if (this.bodyEl) {
      this.bodyEl.remove();
    }

    const modeCls = this.diffMode === "unified"
      ? "lmsa-chat-window-diff-hunk-body--unified"
      : "lmsa-chat-window-diff-hunk-body--split";
    this.bodyEl = this.containerEl.createDiv({ cls: `lmsa-chat-window-diff-hunk-body ${modeCls}` });

    if (this.diffMode === "unified") {
      this.renderUnifiedBody(this.bodyEl);
    } else {
      this.renderSplitBody(this.bodyEl);
    }
  }

  // -----------------------------------------------------------------------
  // Unified mode
  // -----------------------------------------------------------------------

  private renderUnifiedBody(bodyEl: HTMLElement): void {
    const { resolvedEdit } = this.hunk;

    if (resolvedEdit.contextBefore.length > 0) {
      this.renderUnifiedLines(bodyEl, resolvedEdit.contextBefore, "context", resolvedEdit.startLine - resolvedEdit.contextBefore.length);
    }

    const removedLines = resolvedEdit.editBlock.searchText.split("\n");
    const addedLines = resolvedEdit.editBlock.replaceText.split("\n");
    const hasAdded = addedLines.length > 0 && !(addedLines.length === 1 && addedLines[0] === "");
    const pairedCount = hasAdded ? Math.min(removedLines.length, addedLines.length) : 0;

    for (let i = 0; i < pairedCount; i++) {
      const segments = computeWordDiff(removedLines[i], addedLines[i]);
      const lineNum = resolvedEdit.startLine + i;
      this.renderHighlightedLine(bodyEl, segments.removed, "removed", lineNum);
      this.renderHighlightedLine(bodyEl, segments.added, "added");
    }

    if (removedLines.length > pairedCount) {
      this.renderUnifiedLines(bodyEl, removedLines.slice(pairedCount), "removed", resolvedEdit.startLine + pairedCount);
    }

    if (hasAdded && addedLines.length > pairedCount) {
      this.renderUnifiedLines(bodyEl, addedLines.slice(pairedCount), "added");
    }

    if (resolvedEdit.contextAfter.length > 0) {
      this.renderUnifiedLines(bodyEl, resolvedEdit.contextAfter, "context", resolvedEdit.endLine + 1);
    }
  }

  private renderUnifiedLines(
    parent: HTMLElement,
    lines: string[],
    type: "context" | "removed" | "added",
    startLineNumber?: number
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

  private renderHighlightedLine(
    parent: HTMLElement,
    segments: DiffSegment[],
    type: "removed" | "added",
    lineNumber?: number
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

  // -----------------------------------------------------------------------
  // Side-by-side mode
  // -----------------------------------------------------------------------

  private renderSplitBody(bodyEl: HTMLElement): void {
    const { resolvedEdit } = this.hunk;

    // Context before
    if (resolvedEdit.contextBefore.length > 0) {
      const startNum = resolvedEdit.startLine - resolvedEdit.contextBefore.length;
      for (let i = 0; i < resolvedEdit.contextBefore.length; i++) {
        const text = resolvedEdit.contextBefore[i];
        this.renderRow(bodyEl, {
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

      this.renderRow(bodyEl, {
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
        this.renderRow(bodyEl, {
          left: { text, lineNumber: startNum + i, type: "context" },
          right: { text, lineNumber: startNum + i, type: "context" },
        });
      }
    }
  }

  private renderRow(
    parent: HTMLElement,
    sides: { left: SideCellData | null; right: SideCellData | null }
  ): void {
    const rowEl = parent.createDiv({ cls: "lmsa-chat-window-diff-row" });
    this.renderSideCell(rowEl, sides.left, "left");
    this.renderSideCell(rowEl, sides.right, "right");
  }

  private renderSideCell(
    row: HTMLElement,
    data: SideCellData | null,
    side: "left" | "right"
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
}

// ---------------------------------------------------------------------------
// Types & word-level diff utilities
// ---------------------------------------------------------------------------

interface SideCellData {
  text: string;
  lineNumber?: number;
  type: "context" | "removed" | "added";
  segments?: DiffSegment[];
}

interface DiffSegment {
  text: string;
  highlighted: boolean;
}

interface WordDiffResult {
  removed: DiffSegment[];
  added: DiffSegment[];
}

/** Render segments into a text element, highlighting changed portions. */
function renderSegments(textEl: HTMLElement, segments: DiffSegment[]): void {
  const hasContent = segments.some((s) => s.text.length > 0);
  if (!hasContent) {
    textEl.setText(" ");
    return;
  }
  for (const segment of segments) {
    if (segment.text.length === 0) continue;
    if (segment.highlighted) {
      const span = textEl.createSpan({ cls: "lmsa-chat-window-diff-highlight" });
      span.setText(segment.text);
    } else {
      textEl.appendText(segment.text);
    }
  }
}

/**
 * Compute word-level diff between two lines. Splits on word boundaries,
 * finds the longest common prefix and suffix of tokens, and highlights
 * the changed middle segment.
 */
function computeWordDiff(oldLine: string, newLine: string): WordDiffResult {
  if (oldLine === newLine) {
    return {
      removed: [{ text: oldLine, highlighted: false }],
      added: [{ text: newLine, highlighted: false }],
    };
  }

  const oldTokens = tokenize(oldLine);
  const newTokens = tokenize(newLine);

  // Find common prefix tokens
  let prefixLen = 0;
  while (
    prefixLen < oldTokens.length &&
    prefixLen < newTokens.length &&
    oldTokens[prefixLen] === newTokens[prefixLen]
  ) {
    prefixLen++;
  }

  // Find common suffix tokens (not overlapping with prefix)
  let suffixLen = 0;
  while (
    suffixLen < oldTokens.length - prefixLen &&
    suffixLen < newTokens.length - prefixLen &&
    oldTokens[oldTokens.length - 1 - suffixLen] === newTokens[newTokens.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const commonPrefix = oldTokens.slice(0, prefixLen).join("");
  const commonSuffix = oldTokens.slice(oldTokens.length - suffixLen).join("");
  const oldMiddle = oldTokens.slice(prefixLen, oldTokens.length - suffixLen).join("");
  const newMiddle = newTokens.slice(prefixLen, newTokens.length - suffixLen).join("");

  return {
    removed: buildSegments(commonPrefix, oldMiddle, commonSuffix),
    added: buildSegments(commonPrefix, newMiddle, commonSuffix),
  };
}

/** Split text into tokens at word boundaries, preserving whitespace as separate tokens. */
function tokenize(text: string): string[] {
  return text.match(/\S+|\s+/g) ?? [text];
}

function buildSegments(prefix: string, middle: string, suffix: string): DiffSegment[] {
  const segments: DiffSegment[] = [];
  if (prefix) segments.push({ text: prefix, highlighted: false });
  if (middle) segments.push({ text: middle, highlighted: true });
  if (suffix) segments.push({ text: suffix, highlighted: false });
  return segments;
}

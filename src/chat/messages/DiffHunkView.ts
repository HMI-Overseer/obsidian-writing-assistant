import { setIcon } from "obsidian";
import type { DiffHunk, EditStatus } from "../../editing/editTypes";
import { renderUnifiedBody } from "./diff/UnifiedDiffRenderer";
import { renderSplitBody } from "./diff/SplitDiffRenderer";

export type DiffMode = "unified" | "split";

export type DiffHunkCallbacks = {
  onAccept: (hunkId: string) => void;
  onReject: (hunkId: string) => void;
  onUndo: (hunkId: string) => void;
  onModeChange: (mode: DiffMode) => void;
  /** Open the edited note at this hunk's location (the in-hunk filename link). */
  onOpenFile: (evt: MouseEvent) => void;
};

/** Display metadata for a hunk that isn't part of the diff itself. */
export type DiffHunkMeta = {
  /** The target note's filename, rendered as an internal link in the hunk header. */
  fileName: string;
};

/**
 * Renders a single diff hunk with context lines, removed/added lines,
 * and accept/reject controls. Supports both unified and side-by-side modes.
 */
export class DiffHunkView {
  readonly containerEl: HTMLElement;

  private statusEl: HTMLElement;
  private actionsEl: HTMLElement;
  private acceptBtn: HTMLButtonElement | null = null;
  private rejectBtn: HTMLButtonElement | null = null;
  private splitBtn: HTMLButtonElement | null = null;
  private unifiedBtn: HTMLButtonElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private diffMode: DiffMode;
  /**
   * Whether accept / reject live in this card's header. False when the consumer
   * surfaces them elsewhere — e.g. the timeline-folded review puts approve/decline
   * on the tool-call step itself, leaving this card as the pure diff display.
   */
  private readonly showReviewControls: boolean;

  constructor(
    parent: HTMLElement,
    private readonly hunk: DiffHunk,
    private readonly callbacks: DiffHunkCallbacks,
    private readonly meta: DiffHunkMeta,
    initialMode: DiffMode = "split",
    opts: { showReviewControls?: boolean } = {}
  ) {
    this.diffMode = initialMode;
    this.showReviewControls = opts.showReviewControls ?? true;
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

    this.renderModeToggle(this.actionsEl);

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
    this.renderModeToggle(this.actionsEl);
    this.renderReviewButtons(this.actionsEl);
  }

  // -----------------------------------------------------------------------
  // Header
  // -----------------------------------------------------------------------

  private renderHeader(): {
    statusEl: HTMLElement;
    actionsEl: HTMLElement;
    acceptBtn: HTMLButtonElement | null;
    rejectBtn: HTMLButtonElement | null;
  } {
    const headerEl = this.containerEl.createDiv({ cls: "lmsa-chat-window-diff-hunk-header" });

    const metaEl = headerEl.createDiv({ cls: "lmsa-chat-window-diff-hunk-meta" });

    const { startLine, endLine, confidence } = this.hunk.resolvedEdit;
    const locationText =
      startLine === endLine ? `Line ${startLine}` : `Lines ${startLine}–${endLine}`;
    metaEl.createSpan({ cls: "lmsa-chat-window-diff-hunk-location", text: locationText });

    // File + location sit together as one unit: the filename is an internal link
    // the user clicks to open the note at this hunk (concern B).
    const fileLink = metaEl.createEl("a", {
      cls: "lmsa-chat-window-diff-hunk-file internal-link",
      text: this.meta.fileName,
      attr: { href: "#", "aria-label": `Open ${this.meta.fileName} at line ${startLine}` },
    });
    fileLink.addEventListener("click", (evt) => {
      evt.preventDefault();
      this.callbacks.onOpenFile(evt);
    });

    const statusEl = metaEl.createSpan({ cls: "lmsa-chat-window-diff-hunk-confidence" });
    this.renderConfidenceLabel(statusEl, confidence);

    const actionsEl = headerEl.createDiv({ cls: "lmsa-chat-window-diff-hunk-actions" });
    this.renderModeToggle(actionsEl);
    // Accept / reject are omitted when the consumer hosts them elsewhere (the
    // timeline-folded review puts them on the tool-call step).
    const { acceptBtn, rejectBtn } = this.showReviewControls
      ? this.renderReviewButtons(actionsEl)
      : { acceptBtn: null, rejectBtn: null };

    return { statusEl, actionsEl, acceptBtn, rejectBtn };
  }

  private renderModeToggle(container: HTMLElement): void {
    const modeGroup = container.createDiv({ cls: "lmsa-chat-window-btn-group" });

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
  }

  private renderReviewButtons(container: HTMLElement): {
    acceptBtn: HTMLButtonElement;
    rejectBtn: HTMLButtonElement;
  } {
    const reviewGroup = container.createDiv({ cls: "lmsa-chat-window-btn-group" });

    const acceptBtn = reviewGroup.createEl("button", {
      cls: "lmsa-chat-window-btn-group-item lmsa-chat-window-btn-group-item--accept",
      attr: { "aria-label": "Accept change" },
    });
    setIcon(acceptBtn, "check");
    acceptBtn.createSpan({ text: "Accept" });
    acceptBtn.addEventListener("click", () => this.callbacks.onAccept(this.hunk.id));
    this.acceptBtn = acceptBtn;

    const rejectBtn = reviewGroup.createEl("button", {
      cls: "lmsa-chat-window-btn-group-item lmsa-chat-window-btn-group-item--reject",
      attr: { "aria-label": "Reject change" },
    });
    setIcon(rejectBtn, "x");
    rejectBtn.createSpan({ text: "Reject" });
    rejectBtn.addEventListener("click", () => this.callbacks.onReject(this.hunk.id));
    this.rejectBtn = rejectBtn;

    return { acceptBtn, rejectBtn };
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
    this.acceptBtn?.toggleClass("is-active", status === "accepted");
    this.rejectBtn?.toggleClass("is-active", status === "rejected");
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
      renderUnifiedBody(this.bodyEl, this.hunk);
    } else {
      renderSplitBody(this.bodyEl, this.hunk);
    }
  }
}

import { type App, Component, MarkdownRenderer, Notice, setIcon } from "obsidian";
import type { EditProposal, AppliedEditRecord } from "../../editing/editTypes";
import { applyHunksLive } from "../../editing/documentApplicator";
import { DiffHunkView } from "./DiffHunkView";
import type { DiffMode } from "./DiffHunkView";

export type DiffPanelCallbacks = {
  /** Called when the proposal's hunk statuses change (for store persistence). */
  onHunksChanged: (proposal: EditProposal) => void;
  /** Called after edits are applied or undone (for store persistence). */
  onApplied: (record: AppliedEditRecord) => void;
  onUndone: () => void;
};

/**
 * Container component that renders the full edit proposal diff UI
 * inside an assistant chat bubble.
 *
 * Accepting a hunk immediately applies it to the vault file.
 * Rejecting a hunk marks it as skipped with no document change.
 */
export class DiffReviewPanel {
  private hunkViews = new Map<string, DiffHunkView>();
  private appliedRecord: AppliedEditRecord | null = null;
  /** Tracks the character offset where each hunk's replacement was inserted, for accurate undo. */
  private hunkAppliedOffsets = new Map<string, number>();
  /** Prevents concurrent accept/reject operations. */
  private isProcessing = false;
  private diffMode: DiffMode = "split";

  constructor(
    private readonly containerEl: HTMLElement,
    private readonly app: App,
    private readonly owner: Component,
    private readonly proposal: EditProposal,
    private readonly callbacks: DiffPanelCallbacks,
    existingRecord?: AppliedEditRecord
  ) {
    this.appliedRecord = existingRecord ?? null;
    this.render();
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  private render(): void {
    this.containerEl.empty();
    this.containerEl.addClass("lmsa-chat-window-diff-panel");

    this.renderHeader();
    this.renderProse();
    this.renderHunks();
    this.renderFooter();

    if (this.appliedRecord) {
      this.transitionToRestored(this.appliedRecord);
    }
  }

  private renderHeader(): void {
    const headerEl = this.containerEl.createDiv({ cls: "lmsa-chat-window-diff-header" });

    const fileEl = headerEl.createDiv({ cls: "lmsa-chat-window-diff-target-file" });
    const fileIcon = fileEl.createSpan({ cls: "lmsa-chat-window-diff-file-icon" });
    setIcon(fileIcon, "file-text");
    const fileName = this.proposal.targetFilePath.split("/").pop() ?? this.proposal.targetFilePath;
    fileEl.createSpan({ text: fileName });
  }

  private handleModeChange(mode: DiffMode): void {
    if (mode === this.diffMode) return;
    this.diffMode = mode;
    for (const view of this.hunkViews.values()) {
      view.setDiffMode(mode);
    }
  }

  private renderProse(): void {
    if (!this.proposal.prose) return;

    const proseEl = this.containerEl.createDiv({ cls: "lmsa-chat-window-diff-prose" });
    const renderChild = new Component();
    this.owner.addChild(renderChild);

    const sourcePath = this.app.workspace.getActiveFile()?.path ?? "";
    MarkdownRenderer.render(this.app, this.proposal.prose, proseEl, sourcePath, renderChild)
      .catch(() => {
        proseEl.setText(this.proposal.prose);
      });
  }

  private renderHunks(): void {
    const hunksContainer = this.containerEl.createDiv({ cls: "lmsa-chat-window-diff-hunks" });

    for (const hunk of this.proposal.hunks) {
      const view = new DiffHunkView(hunksContainer, hunk, {
        onAccept: (id) => this.handleAcceptHunk(id),
        onReject: (id) => this.handleRejectHunk(id),
        onUndo: (id) => this.handleUndoHunk(id),
        onModeChange: (mode) => this.handleModeChange(mode),
      }, this.diffMode);
      this.hunkViews.set(hunk.id, view);
    }
  }

  private renderFooter(): void {
    // Footer intentionally left empty — individual hunk undo is on each hunk
  }

  // -----------------------------------------------------------------------
  // Accept — immediately applies the hunk to the document
  // -----------------------------------------------------------------------

  private async handleAcceptHunk(hunkId: string): Promise<void> {
    if (this.isProcessing) return;
    const hunk = this.proposal.hunks.find((h) => h.id === hunkId);
    if (!hunk || hunk.status !== "pending") return;

    this.isProcessing = true;
    try {
      const result = await applyHunksLive(this.app, this.proposal.targetFilePath, [hunk]);

      if (result.appliedHunkIds.length === 0) {
        return;
      }

      // Track where the replacement was inserted for accurate undo
      const appliedOffset = result.appliedOffsets.get(hunkId);
      if (appliedOffset !== undefined) {
        this.hunkAppliedOffsets.set(hunkId, appliedOffset);
      }

      const hunkView = this.hunkViews.get(hunkId);
      if (hunkView) {
        hunkView.setAppliedWithUndo();
      }

      hunk.status = "accepted";

      this.updateAppliedRecord(result.postContent, result.appliedHunkIds);

      this.callbacks.onHunksChanged(this.proposal);
      if (this.appliedRecord) this.callbacks.onApplied(this.appliedRecord);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      new Notice(`Failed to apply edit: ${msg}`);
    } finally {
      this.isProcessing = false;
    }
  }

  // -----------------------------------------------------------------------
  // Reject — marks hunk as skipped (no document change)
  // -----------------------------------------------------------------------

  private handleRejectHunk(hunkId: string): void {
    if (this.isProcessing) return;
    const hunk = this.proposal.hunks.find((h) => h.id === hunkId);
    if (!hunk || hunk.status !== "pending") return;

    hunk.status = "rejected";
    this.hunkViews.get(hunkId)?.setApplied(false);
    this.callbacks.onHunksChanged(this.proposal);
  }

  // -----------------------------------------------------------------------
  // Status tracking
  // -----------------------------------------------------------------------

  private updateAppliedRecord(postContent: string, newHunkIds: string[]): void {
    if (!this.appliedRecord) {
      this.appliedRecord = {
        proposalId: this.proposal.id,
        targetFilePath: this.proposal.targetFilePath,
        preApplySnapshot: this.proposal.documentSnapshot,
        postApplySnapshot: postContent,
        appliedAt: Date.now(),
        appliedHunkIds: newHunkIds,
      };
    } else {
      this.appliedRecord.postApplySnapshot = postContent;
      this.appliedRecord.appliedAt = Date.now();
      this.appliedRecord.appliedHunkIds = [
        ...this.appliedRecord.appliedHunkIds,
        ...newHunkIds,
      ];
    }
  }

  // -----------------------------------------------------------------------
  // Per-hunk undo — called from DiffHunkView
  // -----------------------------------------------------------------------

  private async handleUndoHunk(hunkId: string): Promise<void> {
    if (this.isProcessing) return;
    const hunk = this.proposal.hunks.find((h) => h.id === hunkId);
    if (!hunk || hunk.status !== "accepted") return;

    const hunkView = this.hunkViews.get(hunkId);
    if (!hunkView) return;

    this.isProcessing = true;
    try {
      const file = this.app.vault.getFileByPath(this.proposal.targetFilePath);
      if (!file) {
        new Notice("File not found.");
        return;
      }

      // Reverse the hunk: search for replaceText, restore the original matchedText.
      // Use matchedText (what was actually in the document) rather than searchText
      // (what the model provided) — these can differ on whitespace-normalized matches.
      const replaceText = hunk.resolvedEdit.editBlock.replaceText;
      const originalText = hunk.resolvedEdit.matchedText;

      let undoFailed = false;
      let restored = "";
      await this.app.vault.process(file, (currentContent) => {
        // Prefer the tracked offset for accuracy; fall back to indexOf
        let idx = -1;
        const trackedOffset = this.hunkAppliedOffsets.get(hunkId);
        if (
          trackedOffset !== undefined &&
          currentContent.slice(trackedOffset, trackedOffset + replaceText.length) === replaceText
        ) {
          idx = trackedOffset;
        } else {
          idx = currentContent.indexOf(replaceText);
        }

        if (idx === -1) {
          undoFailed = true;
          return currentContent;
        }

        restored = currentContent.slice(0, idx) + originalText + currentContent.slice(idx + replaceText.length);
        return restored;
      });

      if (undoFailed) {
        new Notice("Cannot undo — the document has been modified since this edit was applied.");
        return;
      }

      hunk.status = "pending";
      hunkView.resetToPending();
      this.hunkAppliedOffsets.delete(hunkId);

      // Remove from applied record
      if (this.appliedRecord) {
        this.appliedRecord.appliedHunkIds = this.appliedRecord.appliedHunkIds.filter((id) => id !== hunkId);
        this.appliedRecord.postApplySnapshot = restored;
        if (this.appliedRecord.appliedHunkIds.length === 0) {
          this.appliedRecord = null;
          this.callbacks.onUndone();
        } else {
          this.callbacks.onApplied(this.appliedRecord);
        }
      }

      this.callbacks.onHunksChanged(this.proposal);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      new Notice(`Failed to undo: ${msg}`);
    } finally {
      this.isProcessing = false;
    }
  }

  // -----------------------------------------------------------------------
  // Historical re-render (loading from persistence)
  // -----------------------------------------------------------------------

  private transitionToRestored(record: AppliedEditRecord): void {
    const appliedSet = new Set(record.appliedHunkIds);

    for (const hunk of this.proposal.hunks) {
      const view = this.hunkViews.get(hunk.id);
      if (view) {
        if (appliedSet.has(hunk.id)) {
          // Restored applied hunk — show with undo capability
          view.setAppliedWithUndo();
        } else {
          view.setApplied(false);
        }
      }
    }
  }
}

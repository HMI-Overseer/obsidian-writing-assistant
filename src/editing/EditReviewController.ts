import { type App, Notice } from "obsidian";
import type { AppliedEditRecord, DiffHunk, EditProposal, EditStatus } from "./editTypes";
import { applyHunksLive, undoHunkLive } from "./documentApplicator";

/** Persistence hooks fired as the review's state changes. */
export interface EditReviewCallbacks {
  /** The proposal's hunk statuses changed (persist the proposal). */
  onHunksChanged: (proposal: EditProposal) => void;
  /** Edits were applied or partially undone (persist the applied record). */
  onApplied: (record: AppliedEditRecord) => void;
  /** All applied edits were undone (clear the applied record). */
  onUndone: () => void;
}

/** A single hunk's status transition, broadcast to every subscribed renderer. */
export interface HunkReviewChange {
  hunkId: string;
  status: EditStatus;
}

/** How a hunk should first render — derived from persisted state on construction. */
export type InitialHunkView = "pending" | "applied" | "skipped";

type ReviewListener = (change: HunkReviewChange) => void;

/**
 * The single owner of one {@link EditProposal}'s review: hunk statuses, the
 * applied record, per-hunk applied offsets, and the accept / reject / undo
 * behaviour. Mutation flows exclusively through {@link applyHunksLive} and
 * {@link undoHunkLive}.
 *
 * Renderers (the timeline-folded edit review and the in-note CM6 overlay) are
 * pure subscribers: they call {@link accept} / {@link reject} / {@link undo} and
 * react to {@link subscribe} broadcasts. They never mutate the document
 * themselves, so two views over one controller can never disagree about what was
 * applied.
 */
export class EditReviewController {
  private appliedRecord: AppliedEditRecord | null;
  /** Character offset where each accepted hunk's replacement was inserted (for accurate undo). */
  private readonly appliedOffsets = new Map<string, number>();
  /** Serializes accept / reject / undo so concurrent clicks can't interleave. */
  private isProcessing = false;
  private readonly listeners = new Set<ReviewListener>();

  constructor(
    private readonly app: App,
    readonly proposal: EditProposal,
    private readonly callbacks: EditReviewCallbacks,
    existingRecord?: AppliedEditRecord
  ) {
    this.appliedRecord = existingRecord ?? null;
  }

  get targetFilePath(): string {
    return this.proposal.targetFilePath;
  }

  getStatus(hunkId: string): EditStatus | undefined {
    return this.proposal.hunks.find((h) => h.id === hunkId)?.status;
  }

  /** Hunks still awaiting review that resolved to a real document location. */
  pendingHunks(): DiffHunk[] {
    return this.proposal.hunks.filter(
      (h) => h.status === "pending" && h.resolvedEdit.confidence > 0
    );
  }

  hasPendingHunks(): boolean {
    return this.pendingHunks().length > 0;
  }

  /**
   * How a hunk should first render. With an applied record present (a historical
   * message), hunks in the record show as applied and the rest as skipped —
   * mirroring the pre-controller restore behaviour. Otherwise, status drives it.
   */
  initialHunkView(hunkId: string): InitialHunkView {
    if (this.appliedRecord) {
      return this.appliedRecord.appliedHunkIds.includes(hunkId) ? "applied" : "skipped";
    }
    return this.liveHunkView(hunkId);
  }

  /**
   * How a hunk renders from its live status alone, ignoring any applied record.
   * The in-loop live panel uses this so a still-pending hunk stays interactive
   * even after an earlier hunk in the same turn was applied (the record-first
   * {@link initialHunkView} would lock it as skipped — correct only on restore).
   */
  liveHunkView(hunkId: string): InitialHunkView {
    const status = this.getStatus(hunkId);
    if (status === "accepted") return "applied";
    if (status === "rejected") return "skipped";
    return "pending";
  }

  /** Subscribe to hunk status changes. Returns an unsubscribe function. */
  subscribe(listener: ReviewListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: HunkReviewChange): void {
    for (const listener of this.listeners) listener(change);
  }

  // -----------------------------------------------------------------------
  // Accept — applies the hunk to the document immediately
  // -----------------------------------------------------------------------

  async accept(hunkId: string): Promise<void> {
    if (this.isProcessing) return;
    const hunk = this.proposal.hunks.find((h) => h.id === hunkId);
    if (!hunk || hunk.status !== "pending") return;

    this.isProcessing = true;
    try {
      const result = await applyHunksLive(this.app, this.proposal.targetFilePath, [hunk]);
      if (result.appliedHunkIds.length === 0) return;

      const appliedOffset = result.appliedOffsets.get(hunkId);
      if (appliedOffset !== undefined) this.appliedOffsets.set(hunkId, appliedOffset);

      hunk.status = "accepted";
      this.updateAppliedRecord(result.postContent, result.appliedHunkIds);

      this.callbacks.onHunksChanged(this.proposal);
      if (this.appliedRecord) this.callbacks.onApplied(this.appliedRecord);
      this.emit({ hunkId, status: "accepted" });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      new Notice(`Failed to apply edit: ${msg}`);
    } finally {
      this.isProcessing = false;
    }
  }

  // -----------------------------------------------------------------------
  // Reject — marks the hunk skipped, no document change
  // -----------------------------------------------------------------------

  reject(hunkId: string): void {
    if (this.isProcessing) return;
    const hunk = this.proposal.hunks.find((h) => h.id === hunkId);
    if (!hunk || hunk.status !== "pending") return;

    hunk.status = "rejected";
    this.callbacks.onHunksChanged(this.proposal);
    this.emit({ hunkId, status: "rejected" });
  }

  // -----------------------------------------------------------------------
  // Undo — reverses an accepted hunk
  // -----------------------------------------------------------------------

  async undo(hunkId: string): Promise<void> {
    if (this.isProcessing) return;
    const hunk = this.proposal.hunks.find((h) => h.id === hunkId);
    if (!hunk || hunk.status !== "accepted") return;

    this.isProcessing = true;
    try {
      const file = this.app.vault.getFileByPath(this.proposal.targetFilePath);
      if (!file) {
        new Notice("File not found.");
        return;
      }

      const result = await undoHunkLive(
        this.app,
        this.proposal.targetFilePath,
        hunk,
        this.appliedOffsets.get(hunkId)
      );
      if (!result.undone) {
        new Notice("Cannot undo — the document has been modified since this edit was applied.");
        return;
      }

      hunk.status = "pending";
      this.appliedOffsets.delete(hunkId);

      if (this.appliedRecord) {
        this.appliedRecord.appliedHunkIds = this.appliedRecord.appliedHunkIds.filter(
          (id) => id !== hunkId
        );
        if (result.restoredContent !== null) {
          this.appliedRecord.postApplySnapshot = result.restoredContent;
        }
        if (this.appliedRecord.appliedHunkIds.length === 0) {
          this.appliedRecord = null;
          this.callbacks.onUndone();
        } else {
          this.callbacks.onApplied(this.appliedRecord);
        }
      }

      this.callbacks.onHunksChanged(this.proposal);
      this.emit({ hunkId, status: "pending" });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      new Notice(`Failed to undo: ${msg}`);
    } finally {
      this.isProcessing = false;
    }
  }

  // -----------------------------------------------------------------------
  // Applied-record bookkeeping
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
      this.appliedRecord.appliedHunkIds = [...this.appliedRecord.appliedHunkIds, ...newHunkIds];
    }
  }
}

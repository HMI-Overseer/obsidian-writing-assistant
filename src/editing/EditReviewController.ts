import { type App, Notice } from "obsidian";
import type { AppliedEditRecord, DiffHunk, EditProposal, EditStatus } from "./editTypes";
import { applyHunksLive, undoHunkLive } from "./documentApplicator";
import { detectOverlaps } from "./diffEngine";

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

/** How a hunk should first render, derived from persisted state on construction. */
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
   * message), hunks in the record show as applied and the rest as skipped,
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
   * {@link initialHunkView} would lock it as skipped, correct only on restore).
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
  // Accept, applies the hunk to the document immediately
  // -----------------------------------------------------------------------

  /**
   * True when `a` and `b` were resolved against the same document baseline, i.e. their
   * offsets share a coordinate space and are comparable. Hunks from different tool-loop
   * rounds are anchored to different reads of the file, so comparing their offsets is
   * meaningless: a later-round hunk with a fresh anchor would false-flag as overlapping
   * an applied earlier-round hunk at the same position (the double-edit bug, ADR-0013).
   * Two absent epochs match: a single-snapshot proposal is one baseline.
   */
  private sameBaseline(a: DiffHunk, b: DiffHunk): boolean {
    return a.baselineEpoch === b.baselineEpoch;
  }

  /**
   * True when accepting `hunk` would conflict with one already applied: their source
   * regions intersect *within the same baseline* ({@link sameBaseline}, ADR-0013).
   * Delegates the geometry to the engine's {@link detectOverlaps} over the comparable
   * accepted set plus this hunk, then checks whether the new hunk landed in a
   * conflicting pair. Already-accepted hunks are pairwise-disjoint (each passed this same
   * check), so detectOverlaps' adjacent-pair sweep is exact for the single hunk added, and
   * the result is order-independent (detectOverlaps sorts by offset). Cross-baseline
   * conflicts are instead caught at apply time by the indexOf re-anchor, which fails
   * honestly when the anchor text no longer exists.
   */
  private overlapsAppliedHunk(hunk: DiffHunk): boolean {
    const accepted = this.proposal.hunks.filter(
      (h) => h.status === "accepted" && this.sameBaseline(h, hunk)
    );
    if (accepted.length === 0) return false;
    return detectOverlaps([...accepted, hunk]).some(
      ([first, second]) => first === hunk.id || second === hunk.id
    );
  }

  async accept(hunkId: string): Promise<void> {
    if (this.isProcessing) return;
    const hunk = this.proposal.hunks.find((h) => h.id === hunkId);
    if (!hunk || hunk.status !== "pending") return;

    // Refuse an accept whose source region overlaps an already-applied hunk from the
    // same baseline (ADR-0013). Accepts splice into the live document one-at-a-time and
    // re-anchor by `indexOf` at apply time, so an overlapping same-snapshot hunk would
    // either silently no-op (its matched text was already overwritten) or re-anchor to
    // the wrong place, an order-dependent outcome (diff-engine-real-document-robustness,
    // symptom D / P1-9). The engine reports the conflict via detectOverlaps; the
    // controller, sole owner of accept, decides: block and point the user at the fix.
    if (this.overlapsAppliedHunk(hunk)) {
      new Notice("This edit overlaps one you already applied. Undo that edit first to apply this one.");
      return;
    }

    this.isProcessing = true;
    try {
      const result = await applyHunksLive(this.app, this.proposal.targetFilePath, [hunk]);
      if (result.appliedHunkIds.length === 0) {
        // The re-anchor found no match (the document changed since resolution, e.g. a
        // conflicting hunk from another baseline was applied first). Say so; a silent
        // return would leave an unexplained dead Apply button.
        new Notice("This edit no longer matches the document and was not applied.");
        return;
      }

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

  /**
   * Accept every still-pending, anchorable hunk in one {@link applyHunksLive} pass,
   * the batch counterpart to {@link accept}. Hunks whose source region overlaps an
   * already-applied hunk (or another hunk chosen for this batch) are skipped, mirroring
   * the single-accept overlap guard: the one-at-a-time re-anchor would otherwise no-op or
   * land wrong. Emits one broadcast per applied hunk so both renderers stay in sync.
   */
  async acceptAll(): Promise<void> {
    if (this.isProcessing) return;
    const pending = this.pendingHunks();
    if (pending.length === 0) return;

    // Greedily pick a non-overlapping batch: start from the already-applied set and add
    // each pending hunk only if it doesn't overlap the running set (detectOverlaps sorts
    // by offset, so this is order-independent). Only hunks sharing the candidate's
    // baseline are compared ({@link sameBaseline}, ADR-0013); offsets from different
    // baselines aren't comparable, and a cross-baseline conflict no-ops honestly at
    // apply time instead.
    const running = this.proposal.hunks.filter((h) => h.status === "accepted");
    const batch: DiffHunk[] = [];
    for (const hunk of pending) {
      const comparable = running.filter((h) => this.sameBaseline(h, hunk));
      const conflicts = detectOverlaps([...comparable, hunk]).some(
        ([first, second]) => first === hunk.id || second === hunk.id
      );
      if (conflicts) continue;
      batch.push(hunk);
      running.push(hunk);
    }

    if (batch.length === 0) {
      new Notice("These edits overlap edits you already applied. Undo those first to apply these.");
      return;
    }

    this.isProcessing = true;
    try {
      const result = await applyHunksLive(this.app, this.proposal.targetFilePath, batch);
      if (result.appliedHunkIds.length === 0) {
        new Notice("These edits no longer match the document and were not applied.");
        return;
      }

      const appliedSet = new Set(result.appliedHunkIds);
      for (const hunk of batch) {
        if (!appliedSet.has(hunk.id)) continue;
        // Batch offsets are recorded at splice time (descending order), so a higher-offset
        // hunk's offset can be stale after a lower splice; undo verifies the offset and
        // falls back to indexOf, so this stays safe.
        const appliedOffset = result.appliedOffsets.get(hunk.id);
        if (appliedOffset !== undefined) this.appliedOffsets.set(hunk.id, appliedOffset);
        hunk.status = "accepted";
      }
      this.updateAppliedRecord(result.postContent, result.appliedHunkIds);

      this.callbacks.onHunksChanged(this.proposal);
      if (this.appliedRecord) this.callbacks.onApplied(this.appliedRecord);
      for (const id of result.appliedHunkIds) {
        this.emit({ hunkId: id, status: "accepted" });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      new Notice(`Failed to apply edits: ${msg}`);
    } finally {
      this.isProcessing = false;
    }
  }

  /** Reject every still-pending hunk (including no-match ones), the batch counterpart to {@link reject}. */
  rejectAll(): void {
    if (this.isProcessing) return;
    const pending = this.proposal.hunks.filter((h) => h.status === "pending");
    if (pending.length === 0) return;

    for (const hunk of pending) {
      hunk.status = "rejected";
      this.emit({ hunkId: hunk.id, status: "rejected" });
    }
    this.callbacks.onHunksChanged(this.proposal);
  }

  // -----------------------------------------------------------------------
  // Reject, marks the hunk skipped, no document change
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
  // Undo, reverses an accepted hunk
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
        new Notice("Cannot undo, the document has been modified since this edit was applied.");
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

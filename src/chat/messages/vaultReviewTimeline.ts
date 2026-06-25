import { type App, Notice, setIcon } from "obsidian";
import type {
  AppliedVaultOpRecord,
  ReviewableVaultOp,
  VaultOperation,
  VaultOperationProposal,
  VaultOpStatus,
} from "../../vault-ops/types";
import { applyVaultOpBatch, undoVaultOpBatch } from "../../vault-ops/applyBatch";
import { opPrimaryPath } from "../../vault-ops/summary";

/** Icon per op kind, for synthetic fallback rows (matched steps keep their own). */
const OP_KIND_ICONS: Record<VaultOperation["kind"], string> = {
  create: "file-plus",
  overwrite: "file-plus",
  createDir: "folder-plus",
  move: "file-symlink",
  trash: "trash-2",
  replaceInVault: "replace",
};

/** Tool name behind each op kind, for the positional fallback (`data-tool-name`). */
const TOOL_NAME_BY_KIND: Record<VaultOperation["kind"], string> = {
  create: "write_file",
  overwrite: "write_file",
  createDir: "create_directory",
  move: "move_file",
  trash: "trash_file",
  replaceInVault: "replace_in_vault",
};

/**
 * Folds a {@link VaultOperationProposal} into the agentic timeline (Finding C
 * re-open): the vault ops are tool calls, already shown as timeline steps,
 * so the review lives *on those steps* rather than in a separate panel. Each
 * ask-gated step gains inline Approve / Decline; approving applies that op
 * immediately and the step flips to applied. Auto-gated ops apply on mount. A
 * footer (rendered outside the collapsible step list, so it survives a collapse)
 * offers "Approve all remaining" when several await review and "Undo" while the
 * batch is live. A superseded batch drops its actions entirely.
 *
 * Steps are matched to ops by tool-call id (`AgenticStep.toolCallId` ===
 * `ReviewableVaultOp.sourceToolCallId`, tagged on the element as
 * `data-tool-call-id`). An op with no matching step (e.g. the Claude Code MCP
 * path, which doesn't carry the id) falls back to a synthetic step row so it is
 * never silently unreviewable.
 */

export type VaultReviewCallbacks = {
  /** Op statuses changed (persist the proposal). */
  onOpsChanged: (proposal: VaultOperationProposal) => void;
  /** A batch applied or grew (persist the applied record). */
  onApplied: (record: AppliedVaultOpRecord) => void;
  /** Every applied op was undone (clear the applied record). */
  onUndone: () => void;
  /**
   * An op reached a terminal user decision, `applied` (approved) or `declined`.
   * Only the live in-loop mount sets this: it resolves the pending tool-result
   * promise the model is blocked on (in-loop-tool-approval-blocking-flow). Fired
   * only once an op's {@link VaultOpStatus} actually becomes terminal, so the tool
   * result never asserts an outcome this view doesn't already hold. A failed apply
   * leaves the op pending (retryable) and does NOT fire, the model stays blocked
   * until the user retries or declines.
   */
  onOpResolved?: (opId: string, disposition: "applied" | "declined") => void;
};

export interface VaultReviewTimelineOptions {
  timelineEl: HTMLElement;
  app: App;
  proposal: VaultOperationProposal;
  callbacks: VaultReviewCallbacks;
  existingRecord?: AppliedVaultOpRecord;
  /** Fresh finalization only: apply auto-gated ops once on mount. */
  autoApply?: boolean;
  /**
   * In-loop live mount only: surface ask-gated ops **one at a time**
   * (ask-ops-resolve-as-batch-not-sequential). Only the first awaiting ask op
   * carries Approve / Decline; the rest read "waiting for the previous step", and
   * the "Approve all remaining" footer is suppressed. The user thus decides each op
   * before the next is offered, so an early decline can strand the dependent ops
   * (failed with a reason) before they're ever approved. The finalized review mounts
   * with this off, so the durable surface keeps its batch affordances.
   */
  serial?: boolean;
}

/** Per-status state class on the step element, drives the dot tint (state, not class). */
function statusClass(status: VaultOpStatus, historical: boolean): string {
  if (historical && (status === "pending" || status === "accepted")) return "is-vault-cancelled";
  switch (status) {
    case "applied": return "is-vault-applied";
    case "failed": return "is-vault-failed";
    // A deliberate user decline reads as red (a "this did not happen" signal),
    // distinct from the muted "you moved on before applying" cancel above.
    case "rejected": return "is-vault-rejected";
    case "satisfied": return "is-vault-satisfied";
    default: return "is-vault-awaiting";
  }
}

const ALL_STATE_CLASSES = [
  "is-vault-awaiting",
  "is-vault-applied",
  "is-vault-failed",
  "is-vault-rejected",
  "is-vault-cancelled",
  "is-vault-satisfied",
];

export class VaultReviewTimelineView {
  private appliedRecord: AppliedVaultOpRecord | null;
  private isProcessing = false;
  /** opId → synthetic step element, for ops with no matching live step. */
  private readonly syntheticSteps = new Map<string, HTMLElement>();
  private fallbackListEl: HTMLElement | null = null;
  private footerEl: HTMLElement | null = null;
  /** Serial mode: the one ask op currently offered for decision (recomputed per paint). */
  private activeAskOpId: string | null = null;

  constructor(private readonly opts: VaultReviewTimelineOptions) {
    this.appliedRecord = opts.existingRecord ?? null;
    this.cleanPriorDecorations();
    this.paint();

    // Fresh finalization only: auto-gated ops apply once (historical re-renders
    // pass autoApply=false and carry an existingRecord, so nothing re-applies).
    if (opts.autoApply && !opts.existingRecord && !opts.proposal.historical) {
      const autoOps = opts.proposal.ops.filter((o) => o.gate === "auto" && o.status === "pending");
      if (autoOps.length > 0) void this.applyOps(autoOps);
    }
  }

  // Painting: idempotent, re-run after every state change.

  /**
   * Strip decorations a prior view left on this timeline, so re-mounting on an
   * already-decorated DOM (an incremental history re-render re-runs the proposal
   * pass over kept bubbles) doesn't stack duplicate footers, controls, or state
   * classes. A freshly rebuilt timeline has none of these, this is a no-op there.
   */
  private cleanPriorDecorations(): void {
    const t = this.opts.timelineEl;
    t.querySelectorAll(".lmsa-vault-review-footer, .lmsa-vault-review-fallback").forEach((e) =>
      e.remove(),
    );
    t.querySelectorAll(".lmsa-vault-step-controls").forEach((e) => e.remove());
    t.querySelectorAll(".lmsa-agentic-timeline-step").forEach((e) =>
      e.classList.remove(...ALL_STATE_CLASSES),
    );
  }

  private paint(): void {
    // Serial mode offers exactly one ask op at a time: the first still-awaiting one
    // in proposal order. Recomputed each paint so deciding it surfaces the next.
    this.activeAskOpId = this.opts.serial
      ? this.opts.proposal.ops.find(
          (o) => o.gate === "ask" && (o.status === "pending" || o.status === "accepted"),
        )?.id ?? null
      : null;

    // Per-paint state for step matching: a cursor per tool name (which ordinal of
    // that tool we're on) and the set of steps already claimed, so two ops never
    // decorate the same row.
    const cursors = new Map<string, number>();
    const used = new Set<HTMLElement>();
    for (const op of this.opts.proposal.ops) {
      this.decorateStep(this.locateStep(op, cursors, used), op);
    }
    this.paintFooter();
  }

  /**
   * Find the timeline step for an op, or lazily create a synthetic stand-in.
   * Primary match is by tool-call id (`sourceToolCallId` === `data-tool-call-id`).
   * Belt-and-braces: if the id is missing or unmatched, bind to the Nth live
   * tool-call step of the same tool name, so any future id gap degrades to the
   * right row rather than a synthetic duplicate.
   */
  private locateStep(
    op: ReviewableVaultOp,
    cursors: Map<string, number>,
    used: Set<HTMLElement>,
  ): HTMLElement {
    const toolName = TOOL_NAME_BY_KIND[op.op.kind];
    const ordinal = cursors.get(toolName) ?? 0;
    cursors.set(toolName, ordinal + 1);

    const id = op.sourceToolCallId;
    if (id) {
      const el = this.opts.timelineEl.querySelector<HTMLElement>(
        `[data-tool-call-id="${CSS.escape(id)}"]`,
      );
      if (el) {
        used.add(el);
        return el;
      }
    }

    const candidates = Array.from(
      this.opts.timelineEl.querySelectorAll<HTMLElement>(
        `.lmsa-agentic-timeline-step--tool_call[data-tool-name="${CSS.escape(toolName)}"]`,
      ),
    ).filter((el) => !el.closest(".lmsa-vault-review-fallback"));
    const positional = candidates[ordinal];
    if (positional && !used.has(positional)) {
      used.add(positional);
      return positional;
    }

    return this.ensureSyntheticStep(op);
  }

  private ensureSyntheticStep(op: ReviewableVaultOp): HTMLElement {
    const existing = this.syntheticSteps.get(op.id);
    if (existing) return existing;

    if (!this.fallbackListEl) {
      this.fallbackListEl = this.opts.timelineEl.createDiv({
        cls: "lmsa-agentic-timeline-list lmsa-vault-review-fallback",
      });
    }
    const stepEl = this.fallbackListEl.createDiv({
      cls: "lmsa-agentic-timeline-step lmsa-agentic-timeline-step--tool_call",
    });
    const dotEl = stepEl.createDiv({ cls: "lmsa-agentic-timeline-dot" });
    setIcon(dotEl, OP_KIND_ICONS[op.op.kind] ?? "wrench");
    const bodyEl = stepEl.createDiv({ cls: "lmsa-agentic-timeline-step-body" });
    bodyEl.createSpan({ cls: "lmsa-agentic-timeline-step-name", text: op.summary });
    bodyEl.createSpan({
      cls: "lmsa-agentic-timeline-step-detail",
      text: opPrimaryPath(op.op),
    });
    this.syntheticSteps.set(op.id, stepEl);
    return stepEl;
  }

  private decorateStep(stepEl: HTMLElement, op: ReviewableVaultOp): void {
    const historical = !!this.opts.proposal.historical;
    stepEl.classList.remove(...ALL_STATE_CLASSES);
    stepEl.classList.add(statusClass(op.status, historical));

    const bodyEl =
      stepEl.querySelector<HTMLElement>(".lmsa-agentic-timeline-step-body") ?? stepEl;
    bodyEl.querySelector(":scope > .lmsa-vault-step-controls")?.remove();
    // This step is reviewed, so the overlay owns its state label, drop the base
    // "Failed" word the timeline may have added (it paints first on a history re-render).
    bodyEl.querySelector(":scope > .lmsa-agentic-timeline-step-failed")?.remove();
    const controls = bodyEl.createDiv({ cls: "lmsa-vault-step-controls" });
    // A tool-call step with args carries a row-level click-to-expand handler;
    // approving/declining must not also toggle that, so stop clicks here.
    controls.addEventListener("click", (e) => e.stopPropagation());
    this.renderControls(controls, op, historical);
  }

  private renderControls(
    controls: HTMLElement,
    op: ReviewableVaultOp,
    historical: boolean,
  ): void {
    const awaiting = op.status === "pending" || op.status === "accepted";

    if (historical && awaiting) {
      controls.createSpan({
        cls: "lmsa-vault-step-state",
        text: "Cancelled, you moved on before applying",
      });
      return;
    }

    if (awaiting && op.gate === "ask") {
      // Serial mode: only the active op is decidable; the rest wait their turn, so
      // a dependent op can't be approved before its prerequisite is decided.
      if (this.opts.serial && op.id !== this.activeAskOpId) {
        controls.createSpan({
          cls: "lmsa-vault-step-state",
          text: "waiting for the previous step",
        });
        return;
      }
      if (op.op.kind === "move" && typeof op.linkImpact === "number" && op.linkImpact > 0) {
        controls.createSpan({
          cls: "lmsa-vault-step-state",
          text: `${op.linkImpact} backlink${op.linkImpact === 1 ? "" : "s"}`,
        });
      }
      // Primary "needs you" signal: an inline label in the detail type scale,
      // tinted with the edit-mode accent. The approve/decline that follow
      // are quiet icon-only affordances, not buttons.
      controls.createSpan({ cls: "lmsa-vault-step-pending", text: "pending approval" });

      const approve = controls.createEl("button", {
        cls: "lmsa-vault-step-btn lmsa-vault-step-btn--approve",
        attr: { "aria-label": "Approve" },
      });
      setIcon(approve, "check");
      approve.disabled = this.isProcessing;
      approve.addEventListener("click", () => void this.applyOps([op]));

      const decline = controls.createEl("button", {
        cls: "lmsa-vault-step-btn lmsa-vault-step-btn--decline",
        attr: { "aria-label": "Decline" },
      });
      setIcon(decline, "x");
      decline.disabled = this.isProcessing;
      decline.addEventListener("click", () => this.skip(op.id));
      return;
    }

    if (awaiting && op.gate === "auto") {
      controls.createSpan({ cls: "lmsa-vault-step-state", text: "auto" });
      return;
    }

    if (op.status === "satisfied") {
      controls.createSpan({
        cls: "lmsa-vault-step-state",
        text: op.op.kind === "createDir" ? "Directory already exists" : "Already exists",
      });
      return;
    }
    if (op.status === "applied") {
      controls.createSpan({
        cls: "lmsa-vault-step-state",
        text: op.gate === "auto" ? "Applied · auto" : "Applied",
      });
      return;
    }
    if (op.status === "failed") {
      controls.createSpan({ cls: "lmsa-vault-step-state is-error", text: "Failed" });
      return;
    }
    if (op.status === "rejected") {
      controls.createSpan({ cls: "lmsa-vault-step-state", text: "Declined" });
    }
  }

  /**
   * Turn-level actions, rendered *outside* the collapsible step list (a sibling of
   * the timeline disclosure in `timelineEl`) so they stay reachable when the
   * timeline is collapsed. Dropped entirely once the batch is superseded.
   */
  private paintFooter(): void {
    this.footerEl?.remove();
    this.footerEl = null;
    if (this.opts.proposal.historical) return;

    const appliable = this.appliableOps();
    const hasApplied = !!this.appliedRecord && this.appliedRecord.applied.length > 0;
    // Serial mode offers ops one at a time, so a batch "Approve all" would defeat it.
    const showApproveAll = !this.opts.serial && appliable.length >= 2;
    if (!showApproveAll && !hasApplied) return;

    const footer = this.opts.timelineEl.createDiv({ cls: "lmsa-vault-review-footer" });
    this.footerEl = footer;

    if (showApproveAll) {
      const approveAll = footer.createEl("button", {
        cls: "lmsa-vault-review-footer-btn lmsa-vault-review-footer-btn--approve",
      });
      setIcon(approveAll.createSpan({ cls: "lmsa-vault-review-footer-btn-icon" }), "check");
      approveAll.createSpan({ text: "Approve all remaining" });
      approveAll.disabled = this.isProcessing;
      approveAll.addEventListener("click", () => void this.applyOps(appliable));
    }

    if (hasApplied) {
      const undo = footer.createEl("button", {
        cls: "lmsa-vault-review-footer-btn",
      });
      setIcon(undo.createSpan({ cls: "lmsa-vault-review-footer-btn-icon" }), "undo-2");
      undo.createSpan({ text: "Undo" });
      undo.disabled = this.isProcessing;
      undo.addEventListener("click", () => void this.undo());
    }
  }

  // Actions route through the batch orchestrator (ADR-0006), so its pre-flight,
  // ordering, and drift-guarded undo all hold.

  /** ask-gated ops not yet applied or declined, what Approve / Approve-all commit. */
  private appliableOps(): ReviewableVaultOp[] {
    return this.opts.proposal.ops.filter(
      (o) => o.gate === "ask" && (o.status === "pending" || o.status === "accepted"),
    );
  }

  private async applyOps(toApply: ReviewableVaultOp[]): Promise<void> {
    if (this.isProcessing || toApply.length === 0) return;
    this.isProcessing = true;
    this.paint();
    try {
      const result = await applyVaultOpBatch(
        this.opts.app,
        toApply.map((r) => ({ id: r.id, op: r.op })),
      );
      if (!result.ok) {
        const reason = result.conflicts[0]?.reason ?? result.error ?? "operation failed";
        new Notice(`Couldn't apply vault operations: ${reason}`);
        return; // statuses unchanged, retry once the conflict clears.
      }
      for (const r of toApply) r.status = "applied";
      this.mergeAppliedRecord(result.applied);
      this.opts.callbacks.onOpsChanged(this.opts.proposal);
      if (this.appliedRecord) this.opts.callbacks.onApplied(this.appliedRecord);
      for (const r of toApply) this.opts.callbacks.onOpResolved?.(r.id, "applied");
    } catch (error) {
      new Notice(`Failed to apply vault operations: ${messageOf(error)}`);
    } finally {
      this.isProcessing = false;
      this.paint();
    }
  }

  private skip(opId: string): void {
    if (this.isProcessing) return;
    const op = this.opts.proposal.ops.find((o) => o.id === opId);
    if (!op || (op.status !== "pending" && op.status !== "accepted")) return;
    op.status = "rejected";
    this.paint();
    this.opts.callbacks.onOpsChanged(this.opts.proposal);
    this.opts.callbacks.onOpResolved?.(op.id, "declined");
  }

  private async undo(): Promise<void> {
    if (this.isProcessing || !this.appliedRecord) return;
    this.isProcessing = true;
    this.paint();
    try {
      const record = this.appliedRecord;
      const result = await undoVaultOpBatch(this.opts.app, record);
      if (result.refused) {
        // Drift guard refused before touching disk, vault unchanged, applied state intact.
        new Notice(`Can't undo, ${result.failures[0] ?? "the vault changed since this was applied"}.`);
        return;
      }
      if (!result.ok) {
        new Notice(`Some operations could not be undone: ${result.failures[0] ?? "unknown error"}`);
      }
      const undoneIds = new Set(record.applied.map((a) => a.opId));
      for (const op of this.opts.proposal.ops) {
        if (undoneIds.has(op.id)) op.status = "pending";
      }
      this.appliedRecord = null;
      this.opts.callbacks.onOpsChanged(this.opts.proposal);
      this.opts.callbacks.onUndone();
    } finally {
      this.isProcessing = false;
      this.paint();
    }
  }

  private mergeAppliedRecord(applied: Array<{ opId: string; inverse: VaultOperation }>): void {
    if (!this.appliedRecord) {
      this.appliedRecord = {
        proposalId: this.opts.proposal.id,
        applied: [...applied],
        appliedAt: Date.now(),
      };
    } else {
      this.appliedRecord.applied = [...this.appliedRecord.applied, ...applied];
      this.appliedRecord.appliedAt = Date.now();
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

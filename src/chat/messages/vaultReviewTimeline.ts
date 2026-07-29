import { type App, Keymap, Notice, normalizePath, setIcon } from "obsidian";
import type {
  AppliedVaultOpRecord,
  ReviewableVaultOp,
  VaultOperation,
  VaultOperationProposal,
  VaultOpStatus,
} from "../../vault-ops/types";
import { undoVaultOpBatch } from "../../vault-ops/applyBatch";
import { opDetailLine, opPrimaryPath } from "../../vault-ops/summary";
import { buildWritePreviewHunk } from "../../vault-ops/writePreview";
import { TOOL_LABELS, pendingToolLabel } from "../../tools/metadata";
import { DiffHunkView } from "./DiffHunkView";

/** Icon per op kind, for synthetic fallback rows (matched steps keep their own). */
const OP_KIND_ICONS: Record<VaultOperation["kind"], string> = {
  create: "file-plus",
  overwrite: "file-plus",
  createDir: "folder-plus",
  move: "file-symlink",
  trash: "trash-2",
  moveFolder: "folder-symlink",
  trashFolder: "folder-x",
  replaceInVault: "replace",
};

/** Tool name behind each operation kind, used for historical labels. */
const TOOL_NAME_BY_KIND: Record<VaultOperation["kind"], string> = {
  create: "write_file",
  overwrite: "write_file",
  createDir: "create_directory",
  move: "move_file",
  trash: "trash_file",
  moveFolder: "move_folder",
  trashFolder: "trash_folder",
  replaceInVault: "replace_in_vault",
};

/**
 * Folds a {@link VaultOperationProposal} into the agentic timeline (Finding C
 * re-open): the vault ops are tool calls, already shown as timeline steps, so the
 * review lives *on those steps* rather than in a separate panel.
 *
 * This is a **record, not an actor** (RFC-0012). It renders each op's status, the
 * write preview, the affected-file list of a vault-wide replace, and the Undo footer,
 * and it applies nothing: while a generation is live the approve / decline decision is
 * made in the composer interaction drawer, and {@link LiveVaultReview} owns the apply.
 * Between turns the durable action ledger owns both. A footer (rendered outside the
 * collapsible step list, so it survives a collapse) offers Undo while the batch is
 * live, because undo is a post-decision action on a durable record. A superseded batch
 * drops its actions entirely.
 *
 * Steps are matched to ops by tool-call id (`AgenticStep.toolCallId` ===
 * `ReviewableVaultOp.sourceToolCallId`, tagged on the element as
 * `data-tool-call-id`). An op without exact identity uses a synthetic history row
 * and never claims a provider declaration.
 */

/**
 * What this view still reports. Only Undo mutates from here now, so the surface is one
 * status change and one record clear; the approve / decline decision and its apply both
 * moved out (RFC-0012).
 */
export type VaultReviewCallbacks = {
  /** Op statuses changed (persist the proposal). */
  onOpsChanged: (proposal: VaultOperationProposal) => void;
  /** Every applied op was undone (clear the applied record). */
  onUndone: () => void;
};

export interface VaultReviewTimelineOptions {
  timelineEl: HTMLElement;
  /** Canonical placement by exact declaration identity (ADR-0031). */
  findActionHostByToolCallId?: (toolCallId: string) => HTMLElement | null;
  app: App;
  proposal: VaultOperationProposal;
  callbacks: VaultReviewCallbacks;
  existingRecord?: AppliedVaultOpRecord;
  /**
   * In-loop live mount only: show ask-gated ops as decided **one at a time**
   * (ask-ops-resolve-as-batch-not-sequential). Only the first awaiting ask op reads
   * "pending approval"; the rest read "waiting for the previous step". Now that the
   * decision itself lives in the drawer, this is what shows queue depth on the
   * timeline. The finalized review mounts with this off.
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

interface VaultReviewMounts {
  stateEl: HTMLElement;
  labelHostEl: HTMLElement;
  controlsHostEl: HTMLElement;
  presentationHostEl: HTMLElement;
}

/**
 * The canonical assistant turn exposes a compact action host inside the tool
 * body. Controls belong there, while previews and affected-file lists need the
 * complete tool body as their full-width sibling host.
 */
export function resolveVaultReviewMounts(
  reviewHostEl: HTMLElement,
): VaultReviewMounts {
  if (reviewHostEl.matches(".lmsa-assistant-turn-action-host")) {
    const presentationHostEl =
      reviewHostEl.parentElement ?? reviewHostEl;
    const labelHostEl =
      presentationHostEl.querySelector<HTMLElement>(
        ":scope > .lmsa-assistant-turn-tool-summary",
      ) ?? presentationHostEl;
    return {
      stateEl:
        reviewHostEl.closest<HTMLElement>(
          ".lmsa-assistant-turn-item",
        ) ?? presentationHostEl,
      labelHostEl,
      controlsHostEl: reviewHostEl,
      presentationHostEl,
    };
  }

  const bodyEl =
    reviewHostEl.querySelector<HTMLElement>(
      ".lmsa-agentic-timeline-step-body",
    ) ?? reviewHostEl;
  return {
    stateEl: reviewHostEl,
    labelHostEl: bodyEl,
    controlsHostEl: bodyEl,
    presentationHostEl: bodyEl,
  };
}

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
    t.querySelectorAll(".lmsa-vault-step-controls").forEach((element) => {
      element
        .closest(
          ".lmsa-agentic-timeline-step, .lmsa-assistant-turn-item",
        )
        ?.classList.remove(...ALL_STATE_CLASSES);
      element.remove();
    });
  }

  private paint(): void {
    // Serial mode offers exactly one ask op at a time: the first still-awaiting one
    // in proposal order. Recomputed each paint so deciding it surfaces the next.
    this.activeAskOpId = this.opts.serial
      ? this.opts.proposal.ops.find(
          (o) => o.gate === "ask" && (o.status === "pending" || o.status === "accepted"),
        )?.id ?? null
      : null;

    for (const op of this.opts.proposal.ops) {
      this.decorateStep(this.locateStep(op), op);
    }
    this.paintFooter();
  }

  /**
   * Find the exact timeline step for an operation, or create a synthetic history
   * row when the legacy record has no trustworthy declaration identity.
   */
  private locateStep(op: ReviewableVaultOp): HTMLElement {
    const id = op.sourceToolCallId;
    if (id) {
      if (this.opts.findActionHostByToolCallId) {
        const host = this.opts.findActionHostByToolCallId(id);
        if (!host) {
          throw new Error(
            `No assistant turn action host exists for vault call "${id}".`,
          );
        }
        return host;
      }
      const el = this.opts.timelineEl.querySelector<HTMLElement>(
        `[data-tool-call-id="${CSS.escape(id)}"]`,
      );
      if (el) return el;
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
    const {
      stateEl,
      labelHostEl,
      controlsHostEl,
      presentationHostEl,
    } = resolveVaultReviewMounts(stepEl);
    stateEl.classList.remove(...ALL_STATE_CLASSES);
    stateEl.classList.add(statusClass(op.status, historical));

    controlsHostEl
      .querySelector(":scope > .lmsa-vault-step-controls")
      ?.remove();
    // This step is reviewed, so the overlay owns its state label, drop the base
    // "Failed" word the timeline may have added (it paints first on a history re-render).
    presentationHostEl
      .querySelector(":scope > .lmsa-agentic-timeline-step-failed")
      ?.remove();
    this.relabelStep(labelHostEl, stateEl, op);
    const controls = controlsHostEl.createDiv({
      cls: "lmsa-vault-step-controls",
    });
    // A tool-call step with args carries a row-level click-to-expand handler;
    // approving/declining must not also toggle that, so stop clicks here.
    controls.addEventListener("click", (e) => e.stopPropagation());
    this.renderControls(controls, op, historical);
    // Content preview (write_file only): the diff of what will be written, always
    // visible under the step, so the user reviews the change before approving (F1).
    const previewEl = this.ensurePreview(presentationHostEl, op);
    // Affected-file list (replace_in_vault only): which notes the vault-wide replace
    // rewrites, so its blast radius is reviewable, not just an "N notes" count (F2).
    const replaceListEl = this.ensureReplaceList(
      presentationHostEl,
      op,
    );
    if (presentationHostEl !== controlsHostEl) {
      const presentationEls = [previewEl, replaceListEl].filter(
        (element): element is HTMLElement => element !== null,
      );
      for (const presentationEl of presentationEls.reverse()) {
        controlsHostEl.after(presentationEl);
      }
    }
  }

  /**
   * Keep the step's name and detail correct while the review owns it. Synthetic fallback
   * rows already show the op summary + path, so they are left alone.
   *
   * Name (F4): the base timeline labels a step with the past-tense {@link TOOL_LABELS}
   * ("Wrote file"), which reads as done next to a still-pending approve/decline. Use the
   * present-tense {@link pendingToolLabel} ("Write file") until the op is applied, then
   * flip to past tense.
   *
   * Detail: the target path a reviewer needs ("Create folder" → *which* folder). The
   * Claude Code path records the real detail only once the tool returns, i.e. after
   * approval, so a pending step still shows the streaming "…" placeholder. Fill it from
   * the op so the path is visible at decision time. The plugin loop already sets the
   * same text, so this is idempotent there.
   */
  private relabelStep(
    labelHostEl: HTMLElement,
    stateEl: HTMLElement,
    op: ReviewableVaultOp,
  ): void {
    if (stateEl.closest(".lmsa-vault-review-fallback")) return;
    const nameEl = labelHostEl.querySelector<HTMLElement>(
      ":scope > .lmsa-agentic-timeline-step-name",
    );
    const toolName = TOOL_NAME_BY_KIND[op.op.kind];
    if (nameEl) {
      nameEl.textContent =
        op.status === "applied" ? TOOL_LABELS[toolName] ?? toolName : pendingToolLabel(toolName);
    }

    let detailEl = labelHostEl.querySelector<HTMLElement>(
      ":scope > .lmsa-agentic-timeline-step-detail",
    );
    if (!detailEl) {
      detailEl = labelHostEl.createSpan({
        cls: "lmsa-agentic-timeline-step-detail",
      });
      if (nameEl) {
        labelHostEl.insertBefore(detailEl, nameEl.nextSibling);
      }
    }
    detailEl.textContent = opDetailLine(op.op);
  }

  /**
   * Mount the write_file content preview under a `create` / `overwrite` step (F1),
   * mirroring the edit channel's always-visible diff. Built once and kept: its content
   * is fixed, and an overwrite's "before" is captured the first time (pre-apply), so a
   * later re-paint (or the op applying) never re-reads the file and shows an empty diff.
   * Non-write ops render nothing here; their whole change is the path in the step detail.
   */
  private ensurePreview(
    presentationHostEl: HTMLElement,
    op: ReviewableVaultOp,
  ): HTMLElement | null {
    if (op.op.kind !== "create" && op.op.kind !== "overwrite") {
      return null;
    }

    const existing = presentationHostEl.querySelector<HTMLElement>(
      ":scope > .lmsa-vault-timeline-preview",
    );
    const container =
      existing ??
      presentationHostEl.createDiv({
        cls: "lmsa-vault-timeline-preview",
      });
    // Clicks inside the diff must not toggle the step's raw-args expand.
    if (!existing) container.addEventListener("click", (e) => e.stopPropagation());
    // Keep the preview last so re-created controls sit above it.
    presentationHostEl.appendChild(container);
    if (existing) return container;

    const writeOp = op.op;
    if (writeOp.kind === "create") {
      this.renderPreviewDiff(container, null, writeOp.content, op.id);
      return container;
    }

    // Overwrite: prefer the applied record's inverse (the captured pre-apply content,
    // also correct after the op applied); otherwise read the file, which still holds the
    // old content while the op is pending review.
    const recorded = this.overwriteBefore(op);
    if (recorded !== null) {
      this.renderPreviewDiff(container, recorded, writeOp.content, op.id);
      return container;
    }
    const file = this.opts.app.vault.getFileByPath(normalizePath(writeOp.path));
    if (!file) {
      container.remove(); // nothing to diff against; the step detail still names the file
      return null;
    }
    void this.opts.app.vault.read(file).then(
      (before) => {
        if (!container.isConnected) return;
        // If the op applied while the read was in flight, the inverse holds the true
        // pre-apply content; otherwise the just-read disk content is the "before".
        this.renderPreviewDiff(container, this.overwriteBefore(op) ?? before, writeOp.content, op.id);
      },
      () => container.remove(),
    );
    return container;
  }

  /** Render the write preview's diff into its container (idempotent). */
  private renderPreviewDiff(
    container: HTMLElement,
    before: string | null,
    next: string,
    id: string,
  ): void {
    container.empty();
    const hunk = buildWritePreviewHunk(before, next, id);
    new DiffHunkView(
      container,
      hunk,
      {
        onAccept: () => undefined,
        onReject: () => undefined,
        onUndo: () => undefined,
        onModeChange: () => undefined,
        onOpenFile: () => undefined,
      },
      { fileName: "" },
      "split",
      { showReviewControls: false, showHeader: false },
    );
  }

  /**
   * The pre-apply content of an applied overwrite, from its undo record: the inverse of
   * an `overwrite` is itself an `overwrite` carrying the old content (ADR-0005). Null
   * when the op is not yet applied or has no such inverse.
   */
  private overwriteBefore(op: ReviewableVaultOp): string | null {
    const inverse = this.appliedRecord?.applied.find((a) => a.opId === op.id)?.inverse;
    return inverse && inverse.kind === "overwrite" ? inverse.content : null;
  }

  /**
   * Mount the affected-file list under a `replace_in_vault` step (F2). A vault-wide
   * replace is the broadest-blast-radius op, yet the step shows only `"X" → "Y"` and an
   * "N notes" count. This adds the one fact that hides: *which* notes change, as a
   * collapsed disclosure of internal links + per-file match count (per-file diffs are
   * waived as clutter, matching how editors surface a bulk replace). Built once and kept.
   */
  private ensureReplaceList(
    presentationHostEl: HTMLElement,
    op: ReviewableVaultOp,
  ): HTMLElement | null {
    if (op.op.kind !== "replaceInVault") return null;
    const existing = presentationHostEl.querySelector<HTMLElement>(
      ":scope > .lmsa-vault-replace-files",
    );
    const details =
      existing ??
      this.buildReplaceList(presentationHostEl, op.op);
    // Keep it last so re-created controls sit above it.
    presentationHostEl.appendChild(details);
    return details;
  }

  private buildReplaceList(
    presentationHostEl: HTMLElement,
    op: Extract<VaultOperation, { kind: "replaceInVault" }>,
  ): HTMLElement {
    const details = presentationHostEl.createEl("details", {
      cls: "lmsa-vault-replace-files",
    });
    // Clicks (toggle, link) must not also toggle the step's raw-args expand.
    details.addEventListener("click", (e) => e.stopPropagation());
    const count = op.targets.length;
    details.createEl("summary", {
      cls: "lmsa-vault-replace-files-summary",
      text: `${count} note${count === 1 ? "" : "s"} affected`,
    });
    const list = details.createDiv({ cls: "lmsa-vault-replace-files-list" });
    for (const target of op.targets) {
      const row = list.createDiv({ cls: "lmsa-vault-replace-file" });
      const link = row.createEl("a", {
        cls: "lmsa-vault-replace-file-path internal-link",
        text: target.path,
        attr: { href: "#", "aria-label": `Open ${target.path}` },
      });
      link.addEventListener("click", (evt) => {
        evt.preventDefault();
        void this.opts.app.workspace.openLinkText(target.path, "", Keymap.isModEvent(evt));
      });
      if (typeof target.count === "number") {
        row.createSpan({
          cls: "lmsa-vault-replace-file-count",
          text: `${target.count} match${target.count === 1 ? "" : "es"}`,
        });
      }
    }
    return details;
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
      // The decision itself is made in the composer drawer while the generation is live
      // (RFC-0012); the timeline is the record, so this is a status label, not a
      // control. The diff preview, the affected-file list, and Undo all stay.
      controls.createSpan({ cls: "lmsa-vault-step-pending", text: "pending approval" });
      return;
    }

    if (awaiting && op.gate === "auto") {
      // Auto-applied ops reach the same "approved" state a user-approved op does, with
      // no distinct "auto" marker (Theme E, scoped): the standing posture pill already
      // signals the session is auto-applying.
      controls.createSpan({ cls: "lmsa-vault-step-state", text: "Approved" });
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
      // No distinct "auto" suffix: an auto-applied op is shown in the same applied state
      // a user-approved op reaches (Theme E, scoped).
      controls.createSpan({ cls: "lmsa-vault-step-state", text: "Applied" });
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
   * The Undo action, rendered *outside* the collapsible step list (a sibling of the
   * timeline disclosure in `timelineEl`) so it stays reachable when the timeline is
   * collapsed. Dropped entirely once the batch is superseded.
   *
   * Undo is a post-decision action on a durable record, so it stays here even though
   * the approve / decline decision moved to the composer drawer (RFC-0012).
   */
  private paintFooter(): void {
    this.footerEl?.remove();
    this.footerEl = null;
    if (this.opts.proposal.historical) return;
    if (!this.appliedRecord || this.appliedRecord.applied.length === 0) return;

    const footer = this.opts.timelineEl.createDiv({ cls: "lmsa-vault-review-footer" });
    this.footerEl = footer;

    const undo = footer.createEl("button", {
      cls: "lmsa-vault-review-footer-btn",
    });
    setIcon(undo.createSpan({ cls: "lmsa-vault-review-footer-btn-icon" }), "undo-2");
    undo.createSpan({ text: "Undo" });
    undo.disabled = this.isProcessing;
    undo.addEventListener("click", () => void this.undo());
  }

  // Undo routes through the batch orchestrator (ADR-0006), so its pre-flight,
  // ordering, and drift guard all hold.

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

}

import { type App, Component, MarkdownRenderer, Notice, setIcon } from "obsidian";
import type {
  AppliedVaultOpRecord,
  ReviewableVaultOp,
  VaultOperation,
  VaultOperationProposal,
} from "../../vault-ops/types";
import { applyVaultOpBatch, undoVaultOpBatch } from "../../vault-ops/applyBatch";
import { gateBadgeLabel } from "../../vault-ops/summary";

export type VaultOpPanelCallbacks = {
  /** Called when op statuses change (for store persistence). */
  onOpsChanged: (proposal: VaultOperationProposal) => void;
  /** Called after ops are applied or the applied set grows (for store persistence). */
  onApplied: (record: AppliedVaultOpRecord) => void;
  /** Called after every applied op is undone. */
  onUndone: () => void;
};

/** Per-op status → icon + a state class suffix used for styling. */
const STATUS_PRESENTATION: Record<ReviewableVaultOp["status"], { icon: string; cls: string }> = {
  pending: { icon: "circle-dashed", cls: "is-pending" },
  accepted: { icon: "circle-check", cls: "is-accepted" },
  rejected: { icon: "circle-slash", cls: "is-rejected" },
  applied: { icon: "check-circle-2", cls: "is-applied" },
  failed: { icon: "alert-circle", cls: "is-failed" },
};

/**
 * Renders a VaultOperationProposal as a reviewable checklist inside an assistant
 * chat bubble — the vault-op analogue of {@link DiffReviewPanel} (spec §6).
 *
 * `auto`-gated ops apply immediately as one ordered batch (still shown — "reviewable,
 * never *at* you"); `ask`-gated ops wait for the user to click Apply. Apply and Undo
 * route through the batch orchestrator so pre-flight, dependency ordering, and inverse
 * replay all hold (spec §7).
 */
export class VaultOperationReviewPanel {
  private appliedRecord: AppliedVaultOpRecord | null;
  private isProcessing = false;
  private rowViews = new Map<string, { rowEl: HTMLElement; iconEl: HTMLElement; actionsEl: HTMLElement }>();
  private applyButton: HTMLButtonElement | null = null;
  private undoButton: HTMLButtonElement | null = null;

  constructor(
    private readonly containerEl: HTMLElement,
    private readonly app: App,
    private readonly owner: Component,
    private readonly proposal: VaultOperationProposal,
    private readonly callbacks: VaultOpPanelCallbacks,
    existingRecord?: AppliedVaultOpRecord,
    private readonly autoApply = false,
  ) {
    this.appliedRecord = existingRecord ?? null;
    this.render();

    // Fresh finalization only: apply auto-gated ops once. Historical re-renders
    // pass autoApply=false (and carry an existingRecord) so nothing re-applies.
    if (this.autoApply && !existingRecord) {
      const autoOps = this.proposal.ops.filter((o) => o.gate === "auto" && o.status === "pending");
      if (autoOps.length > 0) void this.applyOps(autoOps);
    }
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  private render(): void {
    this.containerEl.empty();
    this.containerEl.addClass("lmsa-vault-ops-panel");

    this.renderHeader();
    this.renderProse();
    this.renderOps();
    this.renderFooter();
  }

  private renderHeader(): void {
    const headerEl = this.containerEl.createDiv({ cls: "lmsa-vault-ops-header" });
    const iconEl = headerEl.createSpan({ cls: "lmsa-vault-ops-header-icon" });
    setIcon(iconEl, "list-checks");
    const count = this.proposal.ops.length;
    headerEl.createSpan({
      cls: "lmsa-vault-ops-header-title",
      text: `Vault operations (${count})`,
    });
  }

  private renderProse(): void {
    if (!this.proposal.prose) return;
    const proseEl = this.containerEl.createDiv({ cls: "lmsa-vault-ops-prose" });
    const renderChild = new Component();
    this.owner.addChild(renderChild);
    const sourcePath = this.app.workspace.getActiveFile()?.path ?? "";
    MarkdownRenderer.render(this.app, this.proposal.prose, proseEl, sourcePath, renderChild).catch(() => {
      proseEl.setText(this.proposal.prose ?? "");
    });
  }

  private renderOps(): void {
    const listEl = this.containerEl.createDiv({ cls: "lmsa-vault-ops-list" });
    for (const op of this.proposal.ops) {
      this.renderOpRow(listEl, op);
    }
  }

  private renderOpRow(listEl: HTMLElement, op: ReviewableVaultOp): void {
    const rowEl = listEl.createDiv({ cls: "lmsa-vault-op-row" });

    const iconEl = rowEl.createSpan({ cls: "lmsa-vault-op-status-icon" });

    const bodyEl = rowEl.createDiv({ cls: "lmsa-vault-op-body" });
    const lineEl = bodyEl.createDiv({ cls: "lmsa-vault-op-line" });
    lineEl.createSpan({
      cls: `lmsa-vault-op-badge lmsa-vault-op-badge--${op.gate}`,
      text: gateBadgeLabel(op.gate),
    });
    lineEl.createSpan({ cls: "lmsa-vault-op-summary", text: op.summary });

    if (op.op.kind === "move" && typeof op.linkImpact === "number") {
      bodyEl.createDiv({
        cls: "lmsa-vault-op-detail",
        text:
          op.linkImpact === 0
            ? "No backlinks to update"
            : `Updates ${op.linkImpact} backlink${op.linkImpact === 1 ? "" : "s"}`,
      });
    }
    this.renderContentPreview(bodyEl, op.op);

    const actionsEl = rowEl.createDiv({ cls: "lmsa-vault-op-actions" });

    this.rowViews.set(op.id, { rowEl, iconEl, actionsEl });
    this.refreshRow(op);
  }

  /** Collapsible preview of the file content for create / overwrite ops. */
  private renderContentPreview(bodyEl: HTMLElement, op: VaultOperation): void {
    if (op.kind !== "create" && op.kind !== "overwrite") return;
    const details = bodyEl.createEl("details", { cls: "lmsa-vault-op-preview" });
    details.createEl("summary", {
      text: op.kind === "overwrite" ? "Show replacement content" : "Show content",
    });
    const pre = details.createEl("pre", { cls: "lmsa-vault-op-preview-pre" });
    const max = 8000;
    const content = op.content.length > max ? `${op.content.slice(0, max)}\n…` : op.content;
    pre.setText(content);
  }

  private renderFooter(): void {
    const footerEl = this.containerEl.createDiv({ cls: "lmsa-vault-ops-footer" });

    this.applyButton = footerEl.createEl("button", {
      cls: "lmsa-vault-ops-apply-btn mod-cta",
      text: "Apply",
    });
    this.applyButton.addEventListener("click", () => void this.handleApply());

    this.undoButton = footerEl.createEl("button", {
      cls: "lmsa-vault-ops-undo-btn",
      text: "Undo",
    });
    this.undoButton.addEventListener("click", () => void this.handleUndo());

    this.refreshFooter();
  }

  // -----------------------------------------------------------------------
  // State refresh
  // -----------------------------------------------------------------------

  private refreshRow(op: ReviewableVaultOp): void {
    const view = this.rowViews.get(op.id);
    if (!view) return;

    const presentation = STATUS_PRESENTATION[op.status];
    view.rowEl.className = `lmsa-vault-op-row ${presentation.cls}`;
    setIcon(view.iconEl, presentation.icon);

    view.actionsEl.empty();
    // Only ask-gated ops still awaiting a decision get a skip control.
    if (op.gate === "ask" && (op.status === "pending" || op.status === "accepted")) {
      const skipBtn = view.actionsEl.createEl("button", {
        cls: "lmsa-vault-op-skip-btn",
        text: "Skip",
      });
      skipBtn.addEventListener("click", () => this.handleReject(op.id));
    }
  }

  private refreshFooter(): void {
    const appliable = this.appliableOps();
    if (this.applyButton) {
      const count = appliable.length;
      this.applyButton.setText(count > 0 ? `Apply ${count} operation${count === 1 ? "" : "s"}` : "Apply");
      this.applyButton.toggleClass("is-hidden", count === 0);
      this.applyButton.disabled = this.isProcessing || count === 0;
    }
    if (this.undoButton) {
      const hasApplied = !!this.appliedRecord && this.appliedRecord.applied.length > 0;
      this.undoButton.toggleClass("is-hidden", !hasApplied);
      this.undoButton.disabled = this.isProcessing || !hasApplied;
    }
  }

  /** ask-gated ops not yet applied or rejected — what an Apply click commits. */
  private appliableOps(): ReviewableVaultOp[] {
    return this.proposal.ops.filter(
      (o) => o.gate === "ask" && (o.status === "pending" || o.status === "accepted"),
    );
  }

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

  private handleReject(opId: string): void {
    if (this.isProcessing) return;
    const op = this.proposal.ops.find((o) => o.id === opId);
    if (!op || (op.status !== "pending" && op.status !== "accepted")) return;
    op.status = "rejected";
    this.refreshRow(op);
    this.refreshFooter();
    this.callbacks.onOpsChanged(this.proposal);
  }

  private async handleApply(): Promise<void> {
    await this.applyOps(this.appliableOps());
  }

  private async applyOps(toApply: ReviewableVaultOp[]): Promise<void> {
    if (this.isProcessing || toApply.length === 0) return;
    this.isProcessing = true;
    this.refreshFooter();
    try {
      const result = await applyVaultOpBatch(
        this.app,
        toApply.map((r) => ({ id: r.id, op: r.op })),
      );

      if (!result.ok) {
        const reason = result.conflicts[0]?.reason ?? result.error ?? "operation failed";
        new Notice(`Couldn't apply vault operations: ${reason}`);
        return; // statuses unchanged — the user can retry once the conflict clears.
      }

      for (const r of toApply) {
        r.status = "applied";
        this.refreshRow(r);
      }
      this.mergeAppliedRecord(result.applied);
      this.callbacks.onOpsChanged(this.proposal);
      if (this.appliedRecord) this.callbacks.onApplied(this.appliedRecord);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      new Notice(`Failed to apply vault operations: ${msg}`);
    } finally {
      this.isProcessing = false;
      this.refreshFooter();
    }
  }

  private async handleUndo(): Promise<void> {
    if (this.isProcessing || !this.appliedRecord) return;
    this.isProcessing = true;
    this.refreshFooter();
    try {
      const record = this.appliedRecord;
      const result = await undoVaultOpBatch(this.app, record);
      if (!result.ok) {
        new Notice(`Some operations could not be undone: ${result.failures[0] ?? "unknown error"}`);
      }

      // Reset every applied op back to pending so it can be reviewed/re-applied.
      const undoneIds = new Set(record.applied.map((a) => a.opId));
      for (const op of this.proposal.ops) {
        if (undoneIds.has(op.id)) {
          op.status = "pending";
          this.refreshRow(op);
        }
      }
      this.appliedRecord = null;
      this.callbacks.onOpsChanged(this.proposal);
      this.callbacks.onUndone();
    } finally {
      this.isProcessing = false;
      this.refreshFooter();
    }
  }

  private mergeAppliedRecord(applied: Array<{ opId: string; inverse: VaultOperation }>): void {
    if (!this.appliedRecord) {
      this.appliedRecord = {
        proposalId: this.proposal.id,
        applied: [...applied],
        appliedAt: Date.now(),
      };
    } else {
      this.appliedRecord.applied = [...this.appliedRecord.applied, ...applied];
      this.appliedRecord.appliedAt = Date.now();
    }
  }
}

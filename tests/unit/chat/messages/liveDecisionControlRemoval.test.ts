import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

const VAULT = "src/chat/messages/vaultReviewTimeline.ts";
const EDIT = "src/chat/messages/editReviewTimeline.ts";
const MEMORY = "src/chat/messages/memoryReviewTimeline.ts";

/**
 * RFC-0012 criterion 1: while a generation is live, no timeline element exposes a
 * control that approves, declines, or applies a pending mutation, on any of the three
 * channels. The decision is made in the composer drawer; the timeline is a record.
 *
 * Source-text assertions, in the Node environment these tests run in. They are coarse
 * on purpose: the point is that a future edit cannot quietly put a decision control
 * back on a step without this failing.
 */
describe("live timeline decision controls are gone", () => {
  it("leaves no channel able to apply, accept, or reject from a timeline view", () => {
    const views = `${source(VAULT)}\n${source(EDIT)}\n${source(MEMORY)}`;

    // The one apply owner is LiveVaultReview. No timeline view calls the batch
    // orchestrator's apply, nor a controller's accept/reject, any more.
    expect(views).not.toContain("applyVaultOpBatch");
    expect(views).not.toMatch(/controller\.accept\(/u);
    expect(views).not.toMatch(/controller\.acceptAll\(/u);
    expect(views).not.toMatch(/\.rejectAll\(/u);
    expect(views).not.toContain("onApprove");
    expect(views).not.toContain("onDecline");
  });

  it("keeps every removed vault control out of the vault view", () => {
    const vault = source(VAULT);

    expect(vault).not.toContain("lmsa-vault-step-btn");
    expect(vault).not.toContain("Approve all remaining");
    expect(vault).not.toContain("lmsa-vault-review-footer-btn--approve");
    // The internals that only served them.
    expect(vault).not.toMatch(/private (?:async )?applyOps\b/u);
    expect(vault).not.toMatch(/private skip\b/u);
    expect(vault).not.toMatch(/private appliableOps\b/u);
    expect(vault).not.toMatch(/private mergeAppliedRecord\b/u);
    // The autoApply branch had no live caller and is gone with them.
    expect(vault).not.toContain("autoApply");
    // Nothing here resolves a parked decision or grows the applied record any more,
    // so those two callbacks went with the code that fired them.
    expect(vault).not.toContain("onOpResolved");
    expect(vault).not.toContain("onApplied");
  });

  it("keeps the vault view's record: status labels, evidence, and Undo", () => {
    const vault = source(VAULT);

    expect(vault).toContain('text: "pending approval"');
    expect(vault).toContain('text: "Applied"');
    expect(vault).toContain('text: "Declined"');
    expect(vault).toContain('text: "Failed"');
    expect(vault).toContain('text: "waiting for the previous step"');
    expect(vault).toContain('createSpan({ text: "Undo" })');
    expect(vault).toContain("undoVaultOpBatch");
    // The evidence the decision is made against stays on the timeline.
    expect(vault).toContain("lmsa-vault-timeline-preview");
    expect(vault).toContain("lmsa-vault-replace-files");
  });

  it("drops the edit view's accept/reject and the whole bulk bar", () => {
    const edit = source(EDIT);

    expect(edit).not.toContain("lmsa-edit-review-bulk");
    expect(edit).not.toContain("Accept all this session");
    expect(edit).not.toContain("onEnterAutoApply");
    expect(edit).not.toMatch(/private renderBulkBar\b/u);
    expect(edit).not.toMatch(/private (?:async )?acceptAllFiles\b/u);
    expect(edit).not.toMatch(/private allPendingCount\b/u);
    expect(edit).not.toContain('"Accept", "approve"');

    // Applied-state Undo and every status label stay.
    expect(edit).toContain('"Undo", "undo"');
    expect(edit).toContain('text: "Applied"');
    expect(edit).toContain('text: "Skipped"');
    expect(edit).toContain('text: "pending review"');
    // A no-match never parked a decision, so it keeps its own dismiss affordance.
    expect(edit).toContain('"Dismiss", "decline"');
  });

  it("drops the memory view's approve and decline, keeping its label and preview", () => {
    const memory = source(MEMORY);

    expect(memory).not.toContain("lmsa-vault-step-btn");
    expect(memory).not.toContain("callbacks");
    expect(memory).toContain('text: "pending approval"');
    expect(memory).toContain("lmsa-memory-review-preview");
  });

  it("leaves the durable between-turns controls untouched", () => {
    const ledger = source("src/chat/messages/actionLedgerReview.ts");

    // Criterion 2: the ledger still renders its own approve / decline / apply /
    // undo. Those operate between turns and were never in scope.
    expect(ledger).toContain("canApprove");
    expect(ledger).toContain("canDecline");
    expect(ledger).toContain("canApply");
    expect(ledger).toContain("canUndo");
    // Retry is not among them: a failed tool is the model's to resolve, and a
    // transcript that re-fires a stale mutation stops being a record.
    expect(ledger).not.toContain("canRetry");
    expect(ledger).not.toContain('"retry"');
  });
});

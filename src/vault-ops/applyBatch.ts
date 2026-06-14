/**
 * Batch apply & undo orchestration (spec §7) — the bridge between the review
 * panel and the disk-touching executor. It composes the pure planners
 * (`orderOps`, `preflight`, `inverseOf`) with `apply.ts`:
 *
 *   1. order ops into a deterministic dependency order (§7.2),
 *   2. re-resolve every op against live disk — any conflict aborts the whole
 *      batch and nothing is written (§7.1, the real safety guarantee),
 *   3. apply in order, recording each op's inverse; if an op throws mid-batch
 *      (a race that beat pre-flight) roll back the applied ops in reverse (§7.4).
 *
 * Undo replays the recorded inverses in reverse — there is no bespoke undo path.
 */

import type { App } from "obsidian";
import type { AppliedVaultOpRecord, VaultOperation } from "./types";
import { orderOps, preflight, type Conflict } from "./plan";
import { applyOperation, makeDiskSnapshot } from "./apply";

/** A reviewable op paired with its id, so the result can record opId → inverse. */
export interface BatchOp {
  id: string;
  op: VaultOperation;
}

export interface BatchApplyResult {
  ok: boolean;
  /** Pre-flight conflicts (§7.1). Non-empty ⇒ nothing was written. */
  conflicts: Conflict[];
  /** Applied ops with their inverses, in apply order (undo walks this in reverse). */
  applied: Array<{ opId: string; inverse: VaultOperation }>;
  /** Set when an op threw after pre-flight passed (a race); the batch was rolled back. */
  error?: string;
}

/**
 * Apply a batch of accepted ops all-or-nothing (§7.1–7.4). On a pre-flight
 * conflict nothing is written; on a mid-batch throw the applied ops are rolled
 * back via their inverses before returning.
 */
export async function applyVaultOpBatch(app: App, batch: BatchOp[]): Promise<BatchApplyResult> {
  if (batch.length === 0) return { ok: true, conflicts: [], applied: [] };

  // orderOps preserves op references, so we can map ordered ops back to their ids.
  const idByOp = new Map<VaultOperation, string>(batch.map((b) => [b.op, b.id]));
  const ordered = orderOps(batch.map((b) => b.op));

  const preflightResult = preflight(ordered, makeDiskSnapshot(app));
  if (!preflightResult.ok) {
    return { ok: false, conflicts: preflightResult.conflicts, applied: [] };
  }

  const applied: Array<{ opId: string; inverse: VaultOperation }> = [];
  for (const op of ordered) {
    try {
      const inverse = await applyOperation(app, op);
      if (inverse) applied.push({ opId: idByOp.get(op) ?? "", inverse });
    } catch (error) {
      await rollback(app, applied);
      return { ok: false, conflicts: [], applied: [], error: messageOf(error) };
    }
  }
  return { ok: true, conflicts: [], applied };
}

/** Undo an applied batch: replay the recorded inverses in reverse order (§7.4). */
export async function undoVaultOpBatch(
  app: App,
  record: AppliedVaultOpRecord,
): Promise<{ ok: boolean; failures: string[] }> {
  const failures: string[] = [];
  for (let i = record.applied.length - 1; i >= 0; i--) {
    try {
      await applyOperation(app, record.applied[i].inverse);
    } catch (error) {
      failures.push(messageOf(error));
    }
  }
  return { ok: failures.length === 0, failures };
}

/** Best-effort rollback: replay inverses of what was applied, in reverse. */
async function rollback(
  app: App,
  applied: Array<{ opId: string; inverse: VaultOperation }>,
): Promise<void> {
  for (let i = applied.length - 1; i >= 0; i--) {
    try {
      await applyOperation(app, applied[i].inverse);
    } catch {
      // Best-effort — a failed rollback step is surfaced by the caller's notice.
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

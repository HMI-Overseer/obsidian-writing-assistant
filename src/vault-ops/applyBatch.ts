/**
 * Batch apply & undo orchestration (ADR-0006) — the bridge between the review
 * panel and the disk-touching executor. It composes the pure planners
 * (`orderOps`, `preflight`, `inverseOf`) with `apply.ts`:
 *
 *   1. order ops into a deterministic dependency order,
 *   2. re-resolve every op against live disk — any conflict aborts the whole
 *      batch and nothing is written (the real safety guarantee),
 *   3. apply in order, recording each op's inverse; if an op throws mid-batch
 *      (a race that beat pre-flight) roll back the applied ops in reverse.
 *
 * Undo replays the recorded inverses in reverse — there is no bespoke undo path.
 */

import type { App } from "obsidian";
import type { AppliedVaultOpRecord, VaultOperation } from "./types";
import { orderOps, preflight, fingerprintsMatch, type Conflict } from "./plan";
import {
  applyOperation,
  diskFingerprint,
  diskState,
  folderIsEmpty,
  makeDiskSnapshot,
} from "./apply";

/** A reviewable op paired with its id, so the result can record opId → inverse. */
export interface BatchOp {
  id: string;
  op: VaultOperation;
}

export interface BatchApplyResult {
  ok: boolean;
  /** Pre-flight conflicts. Non-empty ⇒ nothing was written. */
  conflicts: Conflict[];
  /** Applied ops with their inverses, in apply order (undo walks this in reverse). */
  applied: Array<{ opId: string; inverse: VaultOperation }>;
  /** Set when an op threw after pre-flight passed (a race); the batch was rolled back. */
  error?: string;
}

/**
 * Apply a batch of accepted ops all-or-nothing. On a pre-flight
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

export interface UndoResult {
  ok: boolean;
  failures: string[];
  /** True when the drift guard refused undo before touching disk (vault unchanged). */
  refused?: boolean;
}

/**
 * Undo an applied batch: replay the recorded inverses in reverse order (ADR-0005).
 *
 * Runs the op-type-aware drift guard first (Finding B, amendment 3): replaying the
 * inverse of a stale trash or move can resurrect or clobber files in a way a
 * content-diff undo cannot, so any drift refuses the whole undo *before* writing
 * anything — strictly safer than the always-replay it replaces.
 */
export async function undoVaultOpBatch(
  app: App,
  record: AppliedVaultOpRecord,
): Promise<UndoResult> {
  const drift = guardVaultUndo(app, record);
  if (drift.length > 0) {
    return { ok: false, refused: true, failures: drift };
  }

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

/**
 * Op-type-aware drift guard for undo (Finding B, amendment 3). Undo applies each
 * recorded *inverse*; if the vault drifted since apply, replaying it can destroy
 * or resurrect newer state. Returns the human reasons undo must be refused —
 * empty ⇒ safe to proceed. The check is keyed to the inverse's kind because the
 * danger differs: undoing a trash (re-creating a file) or a move is categorically
 * riskier than restoring content.
 */
export function guardVaultUndo(app: App, record: AppliedVaultOpRecord): string[] {
  const reasons: string[] = [];
  for (const { inverse } of record.applied) {
    switch (inverse.kind) {
      case "create": {
        // Undo of a trash: re-create the file. If something occupies the path
        // again, the original slot was taken — don't resurrect over it.
        if (diskState(app, inverse.path) !== "absent") {
          reasons.push(`"${inverse.path}" exists again — won't recreate it over the current file.`);
        }
        break;
      }
      case "trash": {
        // Undo of a create / createDir: trash what we made. Already gone ⇒ nothing
        // to undo (not a conflict).
        const state = diskState(app, inverse.path);
        if (state === "absent") break;
        if (state === "dir") {
          // Undo of a createDir trashes the folder — and Obsidian's trash takes the
          // whole subtree. The folder was created empty, so any contents now are
          // files the user added afterwards; trashing them would be silent data
          // loss (Finding E). Refuse rather than delete what's inside.
          if (!folderIsEmpty(app, inverse.path)) {
            reasons.push(
              `"${inverse.path}" is no longer empty — won't trash it and delete what's inside.`,
            );
          }
          break;
        }
        // A real file must still match the fingerprint captured at apply, or we'd
        // trash newer edits. (A folder inverse carries an empty snapshot and a zero
        // fingerprint, so it never reaches this content check.)
        if (inverse.snapshot !== "" || state === "file") {
          if (!fingerprintsMatch(diskFingerprint(app, inverse.path), inverse.expect)) {
            reasons.push(`"${inverse.path}" changed since it was created — won't trash your edits.`);
          }
        }
        break;
      }
      case "overwrite": {
        // Undo of an overwrite: restore prior content. Refuse if the file changed
        // since we overwrote it, or we'd clobber the newer version.
        if (!fingerprintsMatch(diskFingerprint(app, inverse.path), inverse.expect)) {
          reasons.push(`"${inverse.path}" changed since it was overwritten — won't clobber it.`);
        }
        break;
      }
      case "move": {
        // Undo of a move: move it back. The file must still be at the moved-to
        // location, and its original spot must be free.
        if (diskState(app, inverse.from) !== "file") {
          reasons.push(`"${inverse.from}" is no longer there to move back.`);
        }
        if (diskState(app, inverse.to) !== "absent") {
          reasons.push(`"${inverse.to}" exists again — won't overwrite it to undo a move.`);
        }
        break;
      }
      case "createDir":
        // Never produced as an inverse (inverseOf returns trash or null); ignore.
        break;
    }
  }
  return reasons;
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

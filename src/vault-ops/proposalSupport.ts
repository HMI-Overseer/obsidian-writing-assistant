import type { App } from "obsidian";
import { normalizePath } from "obsidian";
import type { ToolCall } from "../tools/types";
import { generateId } from "../utils";
import { readContentOrNull } from "./apply";
import { resolveGate, type Gate, type VaultOpPolicy } from "./gateway";
import { backlinkCount } from "./metadata";
import { summarizeOp } from "./summary";
import type { ReviewableVaultOp, VaultOperation } from "./types";

/**
 * Pre-read the on-disk content of every `trash_file` call so the synchronous
 * conversion can stay synchronous: a trashed file's snapshot is what its inverse
 * re-creates on undo. Keyed by normalized path; non-trash calls and unreadable
 * paths contribute nothing. Shared by both proposal builders (the one-shot
 * finalize path and the in-loop {@link LiveVaultReview} path).
 */
export async function preReadTrashSnapshots(
  app: App,
  calls: ToolCall[],
): Promise<Map<string, string>> {
  const snapshots = new Map<string, string>();
  for (const tc of calls) {
    if (tc.name === "trash_file" && typeof tc.arguments.path === "string") {
      const content = await readContentOrNull(app, tc.arguments.path);
      if (content !== null) snapshots.set(normalizePath(tc.arguments.path), content);
    }
  }
  return snapshots;
}

/**
 * The shared gating contract for a converted op (the security-sensitive seam, now
 * one implementation for both proposal builders). An already-satisfied no-op is
 * forced to `auto` (never gated, never applied); everything else runs through
 * {@link resolveGate}. `autoConsumed` is true only when this op newly spends a slot
 * of the per-turn auto budget, so each caller bumps its own `autoSoFar` in exactly
 * the cases the old inline `gate === "auto" && !isSatisfied` did.
 */
export function gateConvertedOp(
  op: VaultOperation,
  isSatisfied: boolean,
  policy: VaultOpPolicy,
  autoSoFar: number,
): { gate: Gate; autoConsumed: boolean } {
  const gate = isSatisfied ? "auto" : resolveGate(op, policy, autoSoFar);
  return { gate, autoConsumed: gate === "auto" && !isSatisfied };
}

/**
 * Build a {@link ReviewableVaultOp} from a converted op and its already-decided
 * gate (`deny` is handled by the caller and never reaches here). A move op carries
 * its {@link backlinkCount} as `linkImpact`. One implementation for both builders.
 */
export function buildReviewableOp(
  app: App,
  op: VaultOperation,
  gate: "auto" | "ask",
  isSatisfied: boolean,
  sourceToolCallId: string,
): ReviewableVaultOp {
  const reviewable: ReviewableVaultOp = {
    id: generateId(),
    op,
    gate,
    status: isSatisfied ? "satisfied" : "pending",
    summary: summarizeOp(op),
    sourceToolCallId,
  };
  if (op.kind === "move") reviewable.linkImpact = backlinkCount(app, op.from);
  return reviewable;
}

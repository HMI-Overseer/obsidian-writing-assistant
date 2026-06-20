/**
 * Core data model for the vault write surface.
 *
 * See docs/reference/architecture/vault-write-tools.md. These types are portable,
 * no Obsidian imports, so the pure planners (gateway, plan) and validators
 * can be unit-tested with no vault.
 */

/** Disk/overlay existence state for a normalized path. */
export type PathState = "file" | "dir" | "absent";

/** Conflict guard captured at proposal time, re-checked at apply. */
export interface TargetFingerprint {
  mtime: number;
  size: number;
}

/**
 * One vault mutation. `write_file` resolves to `create` or `overwrite` at
 * conversion time from whether the path exists, the model never sets a flag.
 * `trash` carries the trashed file's `snapshot` so its inverse can re-create it.
 */
export type VaultOperation =
  | { kind: "create"; path: string; content: string }
  | { kind: "overwrite"; path: string; content: string; expect: TargetFingerprint }
  | { kind: "createDir"; path: string }
  | { kind: "move"; from: string; to: string; expect: TargetFingerprint }
  | { kind: "trash"; path: string; expect: TargetFingerprint; snapshot: string };

/** The class an op is gated by, identical to its `kind` (ADR-0003). */
export type VaultOpClass = VaultOperation["kind"];

export type VaultOpStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "applied"
  | "failed"
  /** An already-satisfied no-op (e.g. create_directory on an existing folder):
   *  surfaced on its timeline step as an informational note, never applied. */
  | "satisfied";

/** A single reviewable op in a proposal. "deny" never reaches here. */
export interface ReviewableVaultOp {
  id: string;
  op: VaultOperation;
  gate: "auto" | "ask";
  status: VaultOpStatus;
  /** e.g. "Create Characters/Vex.md (1.2 KB)". */
  summary: string;
  /** move only: backlinks that will be rewritten (from metadataCache). */
  linkImpact?: number;
  /**
   * The id of the model tool call this op came from. Links the op to its
   * {@link AgenticStep} timeline step (same id as `AgenticStep.toolCallId`), so
   * the review attaches inline approve/decline to that step rather than a separate
   * panel. Absent for ops with no surfaced tool-call step (e.g. the Claude Code
   * MCP path), which fall back to a synthetic step row.
   */
  sourceToolCallId?: string;
}

/** A per-turn batch of vault ops (ADR-0002), parallel to EditProposal. */
export interface VaultOperationProposal {
  id: string;
  ops: ReviewableVaultOp[];
  createdAt: number;
  /**
   * The model's explanatory text for this turn, rendered above the checklist,
   * but only when no edit proposal accompanies it (the edit panel owns the prose
   * when both channels fire, so it is never shown twice). Mirrors EditProposal.prose.
   */
  prose?: string;
  /**
   * Set once a later user turn supersedes this proposal (Finding B). A
   * proposal is *live* only during the turn that created it; the next user message
   * marks it historical, so the panel renders a locked, compact variant instead of
   * a live footer competing with the current turn. Undo stays *possible* on a
   * historical applied batch, it just stops being a primary affordance.
   */
  historical?: boolean;
}

/** Record of an applied batch; undo = apply inverses in reverse (ADR-0005). */
export interface AppliedVaultOpRecord {
  proposalId: string;
  applied: Array<{ opId: string; inverse: VaultOperation }>;
  appliedAt: number;
}

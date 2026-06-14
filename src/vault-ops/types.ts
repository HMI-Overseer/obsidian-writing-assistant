/**
 * Core data model for the vault write surface.
 *
 * See docs/architecture/vault-write-tools.md §2. These types are portable —
 * no Obsidian imports — so the pure planners (gateway, plan) and validators
 * can be unit-tested with no vault.
 */

/** Disk/overlay existence state for a normalized path. */
export type PathState = "file" | "dir" | "absent";

/** Conflict guard captured at proposal time, re-checked at apply (§2.2). */
export interface TargetFingerprint {
  mtime: number;
  size: number;
}

/**
 * One vault mutation. `write_file` resolves to `create` or `overwrite` at
 * conversion time from whether the path exists — the model never sets a flag.
 * `trash` carries the trashed file's `snapshot` so its inverse can re-create it.
 */
export type VaultOperation =
  | { kind: "create"; path: string; content: string }
  | { kind: "overwrite"; path: string; content: string; expect: TargetFingerprint }
  | { kind: "createDir"; path: string }
  | { kind: "move"; from: string; to: string; expect: TargetFingerprint }
  | { kind: "trash"; path: string; expect: TargetFingerprint; snapshot: string };

/** The class an op is gated by — identical to its `kind` (§5). */
export type VaultOpClass = VaultOperation["kind"];

export type VaultOpStatus = "pending" | "accepted" | "rejected" | "applied" | "failed";

/** A single reviewable op in a proposal (§2.3). "deny" never reaches here. */
export interface ReviewableVaultOp {
  id: string;
  op: VaultOperation;
  gate: "auto" | "ask";
  status: VaultOpStatus;
  /** e.g. "Create Characters/Vex.md (1.2 KB)". */
  summary: string;
  /** move only: backlinks that will be rewritten (from metadataCache). */
  linkImpact?: number;
}

/** A per-turn batch of vault ops (§2.3), parallel to EditProposal. */
export interface VaultOperationProposal {
  id: string;
  ops: ReviewableVaultOp[];
  createdAt: number;
  /**
   * The model's explanatory text for this turn, rendered above the checklist —
   * but only when no edit proposal accompanies it (the edit panel owns the prose
   * when both channels fire, so it is never shown twice). Mirrors EditProposal.prose.
   */
  prose?: string;
}

/** Record of an applied batch; undo = apply inverses in reverse (§2.3, §7.4). */
export interface AppliedVaultOpRecord {
  proposalId: string;
  applied: Array<{ opId: string; inverse: VaultOperation }>;
  appliedAt: number;
}

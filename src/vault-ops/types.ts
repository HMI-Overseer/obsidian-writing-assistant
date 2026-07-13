/**
 * Core data model for the vault write surface.
 *
 * See docs/02-architecture/components/tools/vault-write-surface.md. These types are portable,
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
 *
 * `replaceInVault` is a single composite op for a vault-wide find-and-replace: one
 * tool call, reviewed/applied/undone as one unit, that rewrites every matched
 * file's content. It carries precomputed per-file content (the model never authors
 * file bodies) and is gated as an `overwrite` (see `classOf`), since it is a
 * multi-file content rewrite. Reviewing it as a single unit keeps the in-loop
 * review coordinator and timeline at their 1-call/1-op design.
 *
 * `moveFolder` and `trashFolder` are the folder-level siblings of `move`/`trash`.
 * Unlike a file, a folder has no meaningful `{mtime,size}`, so they carry no
 * {@link TargetFingerprint}: their conflict guard is purely existence-based
 * (re-checked at pre-flight), and `trashFolder` is scoped to folders that hold no
 * *notes* (enforced at apply via `collectFolderSubtree`, ADR-0012): it may remove a
 * husk of empty subfolders in one call, so its inverse is a `createDir` carrying the
 * captured subtree to restore, never a recursive content snapshot. They gate as
 * `move`/`trash` (see `classOf`).
 */
export type VaultOperation =
  | { kind: "create"; path: string; content: string }
  | { kind: "overwrite"; path: string; content: string; expect: TargetFingerprint }
  | {
      kind: "createDir";
      path: string;
      /**
       * Undo-only (ADR-0012). Set only on the inverse of a `trashFolder` that removed a
       * husk of empty subfolders: the full parent-first list of folder paths to re-create
       * on undo (root included), so the whole husk is restored, not just its root. A
       * `create_directory` tool call never sets it.
       */
      subtree?: string[];
    }
  | { kind: "move"; from: string; to: string; expect: TargetFingerprint }
  | { kind: "trash"; path: string; expect: TargetFingerprint; snapshot: string }
  | { kind: "moveFolder"; from: string; to: string }
  | { kind: "trashFolder"; path: string }
  | {
      kind: "replaceInVault";
      search: string;
      replace: string;
      caseSensitive: boolean;
      wholeWord: boolean;
      /**
       * Precomputed per-file change. Each target carries the file's full new
       * content and the conflict guard captured at proposal time (re-checked at
       * apply, like `overwrite`). `count` is that file's match count, surfaced in the
       * review's affected-file list (F2); it is display-only and absent on the
       * inverse (undo restores content directly, no re-scan).
       */
      targets: Array<{ path: string; content: string; expect: TargetFingerprint; count?: number }>;
      /** Total occurrences replaced across all targets, for the summary/disposition. */
      occurrences: number;
    };

/** The class an op is gated by, identical to its `kind` (ADR-0023). */
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

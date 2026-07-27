/**
 * The approval gateway, the whole authorization argument (ADR-0023).
 *
 * `resolveGate` is a total predicate with no "probably fine" branch, pure with
 * no Obsidian and no disk. This is the single most important seam to get right.
 */

import type { ApprovalPosture } from "../shared/types";
import type { VaultOperation, VaultOpClass } from "./types";

/**
 * The fate of a single op. Each class carries one of these as its policy,
 * and `resolveGate` returns one per op:
 *   - `deny`, the tool is removed entirely; the model is never offered it.
 *   - `ask`, the op is queued and waits for an explicit click to apply.
 *   - `auto`, the op auto-applies (still shown, still undoable), bounded by
 *               `scopes` + `maxAutoOps`.
 */
export type Gate = "auto" | "ask" | "deny";

/**
 * The approval policy. Each class carries a three-way {@link Gate} the user sets
 * in settings ("Auto-apply" / "Ask" / "Deny"). `scopes` and `maxAutoOps` are the
 * defense-in-depth behind any `auto` choice: out-of-scope or over-budget auto
 * ops downgrade to `ask`, never the reverse.
 */
export interface VaultOpPolicy {
  create: Gate;
  overwrite: Gate;
  move: Gate;
  trash: Gate;
  createDir: Gate;
  /**
   * In-document edits (`propose_edit` and `update_frontmatter`). Edits are vault
   * ops too (a file mutation), gated like the rest: `deny` removes the edit tools,
   * `ask` blocks on review (today's behaviour), `auto` applies the hunk in-loop,
   * including on a non-active file. See ADR-0018.
   */
  edit: Gate;
  /**
   * Memory mutations (`add_memory` / `forget_memory`). A gate class that is not
   * an operation kind, exactly like `edit`, resolved by `resolveMemoryGate`,
   * which applies the same posture-then-policy order {@link resolveGate} does:
   * the "Edit automatically" posture auto-applies memory mutations too, and
   * overrules a `deny` here as it does everywhere else.
   *
   * Two things stay deliberately different, neither an exception to the gating
   * model. It is not counted by {@link writesPermitted}, because that drives the
   * ambient edit pipeline and a memory-only session must not switch on the diff
   * renderer. And it is surfaced in the Memories tab rather than the VaultOpsTab
   * gate list, which is framed around note operations.
   */
  memory: Gate;
  /** Folder prefixes eligible for "auto"; empty ⇒ whole vault. */
  scopes: string[];
  /**
   * Circuit breaker for the per-class `auto` policy: once this many auto ops accrue
   * in a turn, the rest downgrade to ask. The session-level "Edit automatically"
   * posture is an explicit opt-in to unattended operation and ignores this cap (see
   * {@link resolveGate}).
   */
  maxAutoOps: number;
}

/**
 * Conservative default policy: every class is reviewed (`ask`) and
 * nothing auto-applies on a fresh install, including the idempotent `createDir`.
 * A user who wants an autonomous drafting loop opts in by setting a class to
 * `auto` (optionally confined with `scopes`).
 */
export const DEFAULT_VAULT_OP_POLICY: VaultOpPolicy = {
  create: "ask",
  overwrite: "ask",
  move: "ask",
  trash: "ask",
  createDir: "ask",
  edit: "ask",
  memory: "ask",
  scopes: [],
  maxAutoOps: 50,
};

/**
 * The op classes that carry a gate in {@link VaultOpPolicy}. Excludes the op kinds
 * that gate as a *different* class than their kind ({@link classOf}) rather than
 * carrying their own knob, so they never index the policy directly: `replaceInVault`
 * (gates as `overwrite`), and the folder ops `moveFolder`/`trashFolder` (gate as
 * `move`/`trash`).
 */
export type GatedVaultOpClass = Exclude<
  VaultOpClass,
  "replaceInVault" | "moveFolder" | "trashFolder"
>;

/**
 * Policy gate class of a converted op. Identical to its kind except for the ops
 * that deliberately reuse another class's policy knob (ADR-0023):
 *   - `replaceInVault` gates as `overwrite` (a multi-file content rewrite);
 *   - `moveFolder` gates as `move` (a relocation, just folder-level);
 *   - `trashFolder` gates as `trash` (a removal, empty-folder-only).
 */
export function classOf(op: VaultOperation): GatedVaultOpClass {
  if (op.kind === "replaceInVault") return "overwrite";
  if (op.kind === "moveFolder") return "move";
  if (op.kind === "trashFolder") return "trash";
  return op.kind;
}

/** Every path an op touches (a move/moveFolder touches two; a replace touches all its targets). */
export function targetPaths(op: VaultOperation): string[] {
  if (op.kind === "move" || op.kind === "moveFolder") return [op.from, op.to];
  if (op.kind === "replaceInVault") return op.targets.map((t) => t.path);
  return [op.path];
}

/**
 * The path(s) an op *writes to*, a subset of {@link targetPaths} used by the
 * config-subtree guard. A move's SOURCE is deliberately excluded: relocating a file or
 * folder OUT of the config dir is legitimate, only the destination is a write into it.
 * Trash and replace targets are existing in-vault (in-index) files, never a write into
 * the config subtree, so they contribute no guarded path.
 */
export function writeTargetPaths(op: VaultOperation): string[] {
  switch (op.kind) {
    case "create":
    case "overwrite":
    case "createDir":
      return [op.path];
    case "move":
    case "moveFolder":
      return [op.to];
    default:
      return [];
  }
}

/** True when every path sits inside one of the scope prefixes (empty ⇒ whole vault). */
export function inScope(paths: string[], scopes: string[]): boolean {
  if (scopes.length === 0) return true;
  return paths.every((path) => scopes.some((scope) => isUnderPrefix(path, scope)));
}

function isUnderPrefix(path: string, prefix: string): boolean {
  const p = trimSlashes(path);
  const s = trimSlashes(prefix);
  if (s === "") return true;
  return p === s || p.startsWith(s + "/");
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

/**
 * Decide one operation's fate. `autoSoFar` is the count of ops already
 * resolved to "auto" this turn. `posture` is the session-level override
 * under `"auto"` ("Edit automatically"): every op
 * auto-applies, overriding the per-class gate (ask AND deny) and the scope
 * restriction, with no per-turn cap, an explicit opt-in to unattended operation.
 * The path-boundary refusal in {@link ../chat/actions/liveVaultReview} is the real
 * safety net; `maxAutoOps` only governs the implicit per-class `auto` policy. Under
 * `"ask"` (the default) the per-class policy fires as configured, with the usual
 * tightening-only downgrades: out-of-scope auto→ask, over-budget auto→ask,
 * "deny" short-circuits.
 */
export function resolveGate(
  op: VaultOperation,
  policy: VaultOpPolicy,
  autoSoFar: number,
  posture: ApprovalPosture = "ask",
): Gate {
  if (posture === "auto") return "auto";
  const base = policy[classOf(op)];
  if (base === "deny") return "deny";
  if (!inScope(targetPaths(op), policy.scopes)) return "ask";
  if (base === "auto" && autoSoFar >= policy.maxAutoOps) return "ask";
  return base;
}

/**
 * Whether the session permits any vault write at all. A deny-all policy under the
 * default `ask` posture is a read-only session; the `auto` posture overrules the
 * policy, so it always permits writes. Drives the **ambient edit pipeline**
 * because the plan/chat/edit modes are gone: the edit renderer +
 * diff review run whenever writes are possible (every assistant turn may propose
 * edits), and a read-only session is exactly a deny-all policy.
 */
export function writesPermitted(policy: VaultOpPolicy, posture: ApprovalPosture): boolean {
  if (posture === "auto") return true;
  return (
    policy.edit !== "deny" ||
    policy.create !== "deny" ||
    policy.overwrite !== "deny" ||
    policy.move !== "deny" ||
    policy.trash !== "deny" ||
    policy.createDir !== "deny"
  );
}

/**
 * Decide an in-document edit's fate. Edits are vault ops but not part of the
 * {@link VaultOperation} union (their apply path is the EditReviewController), so
 * they gate by file path against the same `edit` policy, scope, and auto-budget
 * downgrades as {@link resolveGate}. The same `autoSoFar` budget is threaded
 * across both channels so a turn's auto operations are counted together. Like
 * {@link resolveGate}, the `"auto"` posture is unbounded (no `maxAutoOps` cap).
 */
export function resolveEditGate(
  policy: VaultOpPolicy,
  filePath: string,
  autoSoFar: number,
  posture: ApprovalPosture = "ask",
): Gate {
  if (posture === "auto") return "auto";
  const base = policy.edit;
  if (base === "deny") return "deny";
  if (!inScope([filePath], policy.scopes)) return "ask";
  if (base === "auto" && autoSoFar >= policy.maxAutoOps) return "ask";
  return base;
}

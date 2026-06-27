/**
 * The approval gateway, the whole authorization argument (ADR-0003).
 *
 * `resolveGate` is a total predicate with no "probably fine" branch, pure with
 * no Obsidian and no disk. This is the single most important seam to get right.
 */

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
   * including on a non-active file. See docs/work/issues/propose-edit-in-loop-blocking-review.md.
   */
  edit: Gate;
  /** Folder prefixes eligible for "auto"; empty ⇒ whole vault. */
  scopes: string[];
  /** Circuit breaker: once this many auto ops accrue in a turn, the rest downgrade to ask. */
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
  scopes: [],
  maxAutoOps: 20,
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
 * Annotation-derived gate class of an op. Identical to its kind except for the ops
 * that deliberately reuse another class's policy knob (ADR-0003):
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
 * resolved to "auto" this turn. Both downgrades only ever *tighten*:
 * out-of-scope auto→ask, count auto→ask. "deny" short-circuits.
 */
export function resolveGate(
  op: VaultOperation,
  policy: VaultOpPolicy,
  autoSoFar: number,
): Gate {
  const base = policy[classOf(op)];
  if (base === "deny") return "deny";
  if (!inScope(targetPaths(op), policy.scopes)) return "ask";
  if (base === "auto" && autoSoFar >= policy.maxAutoOps) return "ask";
  return base;
}

/**
 * Decide an in-document edit's fate. Edits are vault ops but not part of the
 * {@link VaultOperation} union (their apply path is the EditReviewController), so
 * they gate by file path against the same `edit` policy, scope, and auto-budget
 * downgrades as {@link resolveGate}. The same `autoSoFar` budget is threaded
 * across both channels so a turn's auto operations are counted together.
 */
export function resolveEditGate(
  policy: VaultOpPolicy,
  filePath: string,
  autoSoFar: number,
): Gate {
  const base = policy.edit;
  if (base === "deny") return "deny";
  if (!inScope([filePath], policy.scopes)) return "ask";
  if (base === "auto" && autoSoFar >= policy.maxAutoOps) return "ask";
  return base;
}

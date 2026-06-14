/**
 * The approval gateway — the whole authorization argument (spec §5).
 *
 * `resolveGate` is a total predicate with no "probably fine" branch, pure with
 * no Obsidian and no disk. This is the single most important seam to get right.
 */

import type { VaultOperation, VaultOpClass } from "./types";

export type Gate = "auto" | "ask" | "deny";

export interface VaultOpPolicy {
  create: Gate;
  overwrite: Gate;
  move: Gate;
  trash: Gate;
  createDir: Gate;
  /** Folder prefixes eligible for "auto"; empty ⇒ whole vault. */
  scopes: string[];
  /** Circuit breaker: once this many auto ops accrue in a turn, the rest downgrade to ask. */
  maxAutoOps: number;
}

/**
 * Conservative default policy (spec §11): every destructive class asks, nothing
 * auto-applies outside review; only the idempotent `createDir` is `auto`. Phase 4
 * lifts this onto `PluginSettings.vaultOpPolicy` and the settings UI; finalization
 * falls back to it until then.
 */
export const DEFAULT_VAULT_OP_POLICY: VaultOpPolicy = {
  create: "ask",
  overwrite: "ask",
  move: "ask",
  trash: "ask",
  createDir: "auto",
  scopes: [],
  maxAutoOps: 20,
};

/** Annotation-derived class of an op — identical to its kind. */
export function classOf(op: VaultOperation): VaultOpClass {
  return op.kind;
}

/** Every path an op touches (move touches two). */
export function targetPaths(op: VaultOperation): string[] {
  return op.kind === "move" ? [op.from, op.to] : [op.path];
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
 * Decide one operation's fate (§5). `autoSoFar` is the count of ops already
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

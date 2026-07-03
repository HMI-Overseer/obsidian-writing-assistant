/**
 * Pure presentation helpers for vault ops, turn a
 * VaultOperation into the human summary shown in the review panel checklist.
 * No Obsidian, no disk, so they are unit-testable.
 */

import type { VaultOperation } from "./types";
import type { Gate } from "./gateway";

/** Human-readable byte size of a string's UTF-8 encoding (e.g. "1.2 KB"). */
export function formatBytes(content: string): string {
  const bytes = new TextEncoder().encode(content).length;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Plural-aware "N note(s)" for a replace's target count. */
function noteCountLabel(count: number): string {
  return `${count} note${count === 1 ? "" : "s"}`;
}

/** One-line checklist summary for an op, e.g. "New file Characters/Vex.md (1.2 KB)". */
export function summarizeOp(op: VaultOperation): string {
  switch (op.kind) {
    case "create":
      return `New file ${op.path} (${formatBytes(op.content)})`;
    case "overwrite":
      return `Overwrite ${op.path} (${formatBytes(op.content)})`;
    case "createDir":
      return `New folder ${op.path}`;
    case "move":
      return `Move ${op.from} → ${op.to}`;
    case "trash":
      return `Trash ${op.path}`;
    case "moveFolder":
      return `Move folder ${op.from} → ${op.to}`;
    case "trashFolder":
      return `Trash folder ${op.path}`;
    case "replaceInVault":
      return `Replace "${op.search}" → "${op.replace}" in ${noteCountLabel(op.targets.length)} (${op.occurrences} matches)`;
  }
}

/** Short badge label for a gate: "auto" applies on its own, "ask" awaits review. */
export function gateBadgeLabel(gate: Gate): string {
  switch (gate) {
    case "auto":
      return "Auto";
    case "ask":
      return "Review";
    case "deny":
      return "Denied";
  }
}

/** The single path an op acts on, for hierarchy display (move shows its destination,
 *  a replace its first target as a representative path). */
export function opPrimaryPath(op: VaultOperation): string {
  if (op.kind === "move" || op.kind === "moveFolder") return op.to;
  if (op.kind === "replaceInVault") return op.targets[0]?.path ?? "";
  return op.path;
}

/**
 * Longest common ancestor *directory* shared by every path, the redundant root
 * prefix to strip before indenting the hierarchy. Returns "" when the paths share
 * no leading folder. Only whole path segments count (no partial-name matches).
 */
export function commonAncestorDir(paths: string[]): string {
  if (paths.length === 0) return "";
  // A path's directory is every segment except its leaf (final) name.
  const dirSegments = paths.map((p) => p.split("/").slice(0, -1));
  let common = dirSegments[0];
  for (const segs of dirSegments.slice(1)) {
    let i = 0;
    while (i < common.length && i < segs.length && common[i] === segs[i]) i++;
    common = common.slice(0, i);
  }
  return common.join("/");
}

/** An op's path rendered relative to a stripped root, with its indentation depth. */
export interface OpHierarchyDisplay {
  /** Path with the common root prefix removed. */
  relativePath: string;
  /** Leaf (final segment), the folder or file name shown in the row. */
  leaf: string;
  /** Indentation level: number of folders between the root and this op's leaf. */
  depth: number;
}

/** Locate an op within the hierarchy rooted at `root` (see {@link commonAncestorDir}). */
export function describeOpInHierarchy(op: VaultOperation, root: string): OpHierarchyDisplay {
  const full = opPrimaryPath(op);
  const relativePath = root && full.startsWith(`${root}/`) ? full.slice(root.length + 1) : full;
  const segments = relativePath.split("/");
  return {
    relativePath,
    leaf: segments[segments.length - 1],
    depth: segments.length - 1,
  };
}

/** Muted secondary text shown after an op's leaf name in the hierarchy row. */
export function opDetailText(op: VaultOperation): string {
  switch (op.kind) {
    case "create":
      return `new file · ${formatBytes(op.content)}`;
    case "overwrite":
      return `overwrite · ${formatBytes(op.content)}`;
    case "createDir":
      return "new folder";
    case "move":
      return `moved from ${op.from}`;
    case "trash":
      return "trash";
    case "moveFolder":
      return `folder moved from ${op.from}`;
    case "trashFolder":
      return "trash folder";
    case "replaceInVault":
      return `replace · ${op.occurrences} match${op.occurrences === 1 ? "" : "es"}`;
  }
}

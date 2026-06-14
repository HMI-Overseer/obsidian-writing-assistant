/**
 * Pure presentation helpers for vault ops (spec §2.3, §6) — turn a
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

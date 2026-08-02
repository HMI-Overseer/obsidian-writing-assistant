/**
 * The pending overlay: a virtual vault view that overlays disk state
 * with the ops accumulated so far this turn, so a later round's `move A→B`
 * sees an earlier round's `write_file A`. Makes in-loop validation smart; it is
 * NOT the safety guarantee, pre-flight (plan.ts) is. Pure.
 */

import type { PathState, VaultOperation } from "../../vault-ops/types";

/** Disk state overlaid with the ops accumulated so far this turn. */
export type PendingOverlay = Map<string, PathState>;

/**
 * Build the overlay from accumulated ops, applied in array order (later ops
 * win): creates/overwrites ⇒ "file", createDir ⇒ "dir", moves ⇒ source
 * "absent" + dest "file", trashes ⇒ "absent".
 */
export function buildOverlay(ops: VaultOperation[]): PendingOverlay {
  const overlay: PendingOverlay = new Map();
  for (const op of ops) {
    switch (op.kind) {
      case "create":
      case "overwrite":
        overlay.set(op.path, "file");
        break;
      case "createDir":
        overlay.set(op.path, "dir");
        break;
      case "move":
        overlay.set(op.from, "absent");
        overlay.set(op.to, "file");
        break;
      case "trash":
        overlay.set(op.path, "absent");
        break;
      case "moveFolder":
        overlay.set(op.from, "absent");
        overlay.set(op.to, "dir");
        break;
      case "trashFolder":
        overlay.set(op.path, "absent");
        break;
      case "replaceInVault":
        // Content-only change; the targets stay files. (In practice a replace never
        // reaches the overlay, its conversion probe yields no targets there, but the
        // path state it implies is "still a file".)
        for (const t of op.targets) overlay.set(t.path, "file");
        break;
    }
  }
  return overlay;
}

/** Resolve a path's state: overlay first, then disk. */
export function makeResolver(
  overlay: PendingOverlay,
  diskState: (path: string) => PathState,
): (path: string) => PathState {
  return (path) => overlay.get(path) ?? diskState(path);
}

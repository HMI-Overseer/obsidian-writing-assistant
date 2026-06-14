/**
 * The pending overlay (spec §4): a virtual vault view that overlays disk state
 * with the ops accumulated so far this turn, so a later round's `move_file A→B`
 * sees an earlier round's `write_file A`. Makes in-loop validation smart; it is
 * NOT the safety guarantee — pre-flight (plan.ts §7) is. Pure.
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
    }
  }
  return overlay;
}

/** Resolve a path's state: overlay first, then disk (§4). */
export function makeResolver(
  overlay: PendingOverlay,
  diskState: (path: string) => PathState,
): (path: string) => PathState {
  return (path) => overlay.get(path) ?? diskState(path);
}

/**
 * The apply executor (spec §7.3) — the only place vault ops touch disk.
 *
 * Thin and integration-tested: the pure planners (gateway, plan) decide *what*
 * and *in what order*; this module performs the real `vault.*` / `fileManager.*`
 * calls and gathers the InverseContext each op's inverse needs (pre-overwrite
 * content, post-apply fingerprints), so undo is just replaying inverses (§7.4).
 */

import type { App } from "obsidian";
import { TFile, TFolder, normalizePath } from "obsidian";
import type { PathState, TargetFingerprint, VaultOperation } from "./types";
import type { DiskSnapshot } from "./plan";
import { inverseOf } from "./plan";

// ---------------------------------------------------------------------------
// Disk probes — back the pure planners' injected data with the live vault.
// ---------------------------------------------------------------------------

/** Live existence state for a path. */
export function diskState(app: App, path: string): PathState {
  const file = app.vault.getAbstractFileByPath(normalizePath(path));
  if (file instanceof TFolder) return "dir";
  if (file instanceof TFile) return "file";
  return "absent";
}

/**
 * True when `path` is an empty folder (no children). Non-folders — files or
 * absent paths — count as empty, so the only `false` is a folder that has
 * gained contents. Used by the undo drift guard: a `createDir` is always made
 * empty, so any children present at undo time are drift and must block the
 * "trash the folder" inverse from deleting them (Finding E).
 */
export function folderIsEmpty(app: App, path: string): boolean {
  const file = app.vault.getAbstractFileByPath(normalizePath(path));
  if (!(file instanceof TFolder)) return true;
  return file.children.length === 0;
}

/** Live {mtime,size} for a file's conflict guard; null if absent or a folder. */
export function diskFingerprint(app: App, path: string): TargetFingerprint | null {
  const file = app.vault.getFileByPath(normalizePath(path));
  if (!file) return null;
  return { mtime: file.stat.mtime, size: file.stat.size };
}

/** Current file content (used as a trash snapshot for undo); null if absent. */
export async function readContentOrNull(app: App, path: string): Promise<string | null> {
  const file = app.vault.getFileByPath(normalizePath(path));
  if (!file) return null;
  return app.vault.read(file);
}

/** A DiskSnapshot (plan.ts) backed by the live vault, for apply-time pre-flight. */
export function makeDiskSnapshot(app: App): DiskSnapshot {
  return {
    state: (path) => diskState(app, path),
    fingerprint: (path) => diskFingerprint(app, path),
  };
}

// ---------------------------------------------------------------------------
// Single-op apply — returns the op's inverse (null when there is nothing to undo).
// ---------------------------------------------------------------------------

/**
 * Apply one vault operation against the live vault and return its inverse
 * (spec §7.3, §7.4). Inverse context is gathered here — pre-overwrite content
 * and post-apply fingerprints — and fed to the pure `inverseOf`.
 *
 * Throws if the operation cannot proceed (e.g. a target vanished after
 * pre-flight). The caller (Phase 3 batch applier) rolls back applied ops.
 */
export async function applyOperation(
  app: App,
  op: VaultOperation,
): Promise<VaultOperation | null> {
  switch (op.kind) {
    case "create": {
      const path = normalizePath(op.path);
      await ensureParentFolder(app, path);
      await app.vault.create(path, op.content);
      return inverseOf(op, { fingerprint: diskFingerprint(app, path) ?? undefined });
    }
    case "overwrite": {
      const path = normalizePath(op.path);
      const file = app.vault.getFileByPath(path);
      if (!file) throw new Error(`overwrite target "${op.path}" no longer exists.`);
      const preContent = await app.vault.read(file);
      await app.vault.process(file, () => op.content);
      return inverseOf(op, { preContent, fingerprint: diskFingerprint(app, path) ?? undefined });
    }
    case "createDir": {
      const path = normalizePath(op.path);
      const dirPreExisted = diskState(app, path) === "dir";
      if (!dirPreExisted) await app.vault.createFolder(path);
      return inverseOf(op, { dirPreExisted });
    }
    case "move": {
      const from = normalizePath(op.from);
      const to = normalizePath(op.to);
      const file = app.vault.getFileByPath(from);
      if (!file) throw new Error(`move source "${op.from}" no longer exists.`);
      await ensureParentFolder(app, to);
      // fileManager.renameFile rewrites every wikilink/backlink — never vault.rename.
      await app.fileManager.renameFile(file, to);
      return inverseOf(op, { fingerprint: diskFingerprint(app, to) ?? undefined });
    }
    case "trash": {
      const path = normalizePath(op.path);
      // getAbstractFileByPath (not getFileByPath) so undo of a createDir, whose
      // inverse trashes a *folder*, finds its target instead of throwing.
      const file = app.vault.getAbstractFileByPath(path);
      if (!file) throw new Error(`trash target "${op.path}" no longer exists.`);
      // fileManager.trashFile honors the user's deleted-files preference — never vault.delete.
      await app.fileManager.trashFile(file);
      return inverseOf(op, {});
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Ensure a file's parent folder exists, creating missing ancestors (§7.3). */
async function ensureParentFolder(app: App, filePath: string): Promise<void> {
  const parent = parentOf(filePath);
  if (parent) await ensureFolder(app, parent);
}

async function ensureFolder(app: App, folderPath: string): Promise<void> {
  const path = normalizePath(folderPath);
  if (path === "" || path === "/" || path === ".") return;
  if (diskState(app, path) === "dir") return;
  const parent = parentOf(path);
  if (parent) await ensureFolder(app, parent);
  if (diskState(app, path) !== "dir") await app.vault.createFolder(path);
}

function parentOf(path: string): string {
  const normalized = normalizePath(path);
  const idx = normalized.lastIndexOf("/");
  return idx > 0 ? normalized.slice(0, idx) : "";
}

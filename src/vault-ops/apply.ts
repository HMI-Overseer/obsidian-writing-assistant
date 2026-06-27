/**
 * The apply executor, the only place vault ops touch disk.
 *
 * Thin and integration-tested: the pure planners (gateway, plan) decide *what*
 * and *in what order*; this module performs the real `vault.*` / `fileManager.*`
 * calls and gathers the InverseContext each op's inverse needs (pre-overwrite
 * content, post-apply fingerprints), so undo is just replaying inverses.
 */

import type { App } from "obsidian";
import { TFile, TFolder, normalizePath } from "obsidian";
import type { PathState, TargetFingerprint, VaultOperation } from "./types";
import type { DiskSnapshot, InverseContext } from "./plan";
import { inverseOf } from "./plan";
import { targetPaths } from "./gateway";
import { escapesVault } from "./pathSafety";

// ---------------------------------------------------------------------------
// Disk probes, back the pure planners' injected data with the live vault.
// ---------------------------------------------------------------------------

/** Live existence state for a path. */
export function diskState(app: App, path: string): PathState {
  const file = app.vault.getAbstractFileByPath(normalizePath(path));
  if (file instanceof TFolder) return "dir";
  if (file instanceof TFile) return "file";
  return "absent";
}

/**
 * True when `path` is an empty folder (no children). Non-folders, files or
 * absent paths, count as empty, so the only `false` is a folder that has
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
// Single-op apply, returns the op's inverse (null when there is nothing to undo).
// ---------------------------------------------------------------------------

/**
 * Apply one vault operation against the live vault and return its inverse.
 * Inverse context is gathered here, pre-overwrite content
 * and post-apply fingerprints, and fed to the pure `inverseOf`.
 *
 * Throws if the operation cannot proceed (e.g. a target vanished after
 * pre-flight). The caller (Phase 3 batch applier) rolls back applied ops.
 */
export async function applyOperation(
  app: App,
  op: VaultOperation,
): Promise<VaultOperation | null> {
  // Last line of defense before disk: never resolve a path outside the vault, even
  // if pre-flight was bypassed. `vault.create`/`renameFile` would otherwise let a
  // `..`/drive-letter path escape via path.join.
  for (const p of targetPaths(op)) {
    if (escapesVault(p)) throw new Error(`refusing to apply "${p}": path is outside the vault.`);
  }
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
      // fileManager.renameFile rewrites every wikilink/backlink, never vault.rename.
      await app.fileManager.renameFile(file, to);
      return inverseOf(op, { fingerprint: diskFingerprint(app, to) ?? undefined });
    }
    case "trash": {
      const path = normalizePath(op.path);
      // getAbstractFileByPath (not getFileByPath) so undo of a createDir, whose
      // inverse trashes a *folder*, finds its target instead of throwing.
      const file = app.vault.getAbstractFileByPath(path);
      if (!file) throw new Error(`trash target "${op.path}" no longer exists.`);
      // fileManager.trashFile honors the user's deleted-files preference, never vault.delete.
      await app.fileManager.trashFile(file);
      return inverseOf(op, {});
    }
    case "moveFolder": {
      const from = normalizePath(op.from);
      const to = normalizePath(op.to);
      const folder = app.vault.getAbstractFileByPath(from);
      if (!(folder instanceof TFolder)) {
        throw new Error(`move source "${op.from}" is not a folder or no longer exists.`);
      }
      await ensureParentFolder(app, to);
      // fileManager.renameFile rewrites every descendant wikilink/backlink for a folder
      // move too, the same primitive the file case relies on, never vault.rename.
      await app.fileManager.renameFile(folder, to);
      return inverseOf(op, {});
    }
    case "trashFolder": {
      const path = normalizePath(op.path);
      const folder = app.vault.getAbstractFileByPath(path);
      if (!(folder instanceof TFolder)) {
        throw new Error(`trash target "${op.path}" is not a folder or no longer exists.`);
      }
      // Empty-only guarantee (the safe carve-out of the v1 folder-removal ban): refuse a
      // populated folder so a folder trash can never recursively delete notes. Any
      // same-batch move out of this folder has already applied (ordered first), so a
      // husk emptied this turn passes here.
      if (!folderIsEmpty(app, path)) {
        throw new Error(`folder "${op.path}" is not empty; only empty folders can be trashed.`);
      }
      await app.fileManager.trashFile(folder);
      return inverseOf(op, {});
    }
    case "replaceInVault": {
      // Rewrite each target to its precomputed content (the same vault.process
      // primitive as overwrite), capturing pre-content + post fingerprint per file so
      // the single composite inverse can restore them all on undo.
      const replaceTargets: InverseContext["replaceTargets"] = [];
      for (const target of op.targets) {
        const path = normalizePath(target.path);
        const file = app.vault.getFileByPath(path);
        if (!file) throw new Error(`replace target "${target.path}" no longer exists.`);
        const preContent = await app.vault.read(file);
        await app.vault.process(file, () => target.content);
        replaceTargets.push({
          path: target.path,
          preContent,
          fingerprint: diskFingerprint(app, path) ?? { mtime: 0, size: 0 },
        });
      }
      return inverseOf(op, { replaceTargets });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Ensure a file's parent folder exists, creating missing ancestors. */
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

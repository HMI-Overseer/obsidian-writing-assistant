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
import { targetPaths, writeTargetPaths } from "./gateway";
import { escapesVault, isReservedConfigPath } from "./pathSafety";

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
 * "trash the folder" inverse from deleting them (Finding E). NB this is a
 * *literal* emptiness (no children at all), distinct from the files-safe check
 * the folder trash uses ({@link collectFolderSubtree}, ADR-0012).
 */
export function folderIsEmpty(app: App, path: string): boolean {
  const file = app.vault.getAbstractFileByPath(normalizePath(path));
  if (!(file instanceof TFolder)) return true;
  return file.children.length === 0;
}

/**
 * Walk a folder's whole subtree once, collecting every descendant note path and
 * every folder path (ADR-0012). `files` is each {@link TFile} anywhere beneath
 * `folder`; `folders` is `folder` itself plus every descendant folder in
 * *parent-first* order, so re-creating them in sequence always makes a parent
 * before its child.
 *
 * The folder trash reads both: `files` empty ⇒ the whole subtree is only empty
 * folders and is safe to remove in one call (Obsidian's trash takes the subtree),
 * and `folders` is captured as the undo payload so a husk of empty subfolders is
 * restored whole, not just its root. When `files` is non-empty the trash is
 * refused and the list names exactly what blocks it.
 */
export function collectFolderSubtree(folder: TFolder): { files: string[]; folders: string[] } {
  const files: string[] = [];
  const folders: string[] = [folder.path];
  const walk = (dir: TFolder): void => {
    for (const child of dir.children) {
      if (child instanceof TFolder) {
        folders.push(child.path);
        walk(child);
      } else if (child instanceof TFile) {
        files.push(child.path);
      }
    }
  };
  walk(folder);
  return { files, folders };
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
 * pre-flight). The batch applier rolls back applied ops.
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
  // Same last-line treatment for the config-subtree guard: never write into the config
  // dir (destination-only, so a move OUT of it still applies), even if the pre-flight
  // config check was absent. A `..` that path.join collapses into the dir is caught here.
  const configDir = app.vault.configDir;
  if (configDir) {
    for (const p of writeTargetPaths(op)) {
      if (isReservedConfigPath(p, configDir)) {
        throw new Error(`refusing to apply "${p}": path is inside the ${configDir} configuration folder.`);
      }
    }
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
      // Undo of a subtree folder trash (ADR-0012): re-create every husk folder that
      // was removed, parent-first, so the whole husk comes back and not just its root.
      // Idempotent, skip any path a later file or folder already occupies. Its own
      // inverse trashes the root (which takes the recreated subtree), staying symmetric.
      if (op.subtree && op.subtree.length > 0) {
        for (const raw of op.subtree) {
          const p = normalizePath(raw);
          if (diskState(app, p) === "absent") await app.vault.createFolder(p);
        }
        return inverseOf(op, { dirPreExisted: false });
      }
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
      // Files-safe guarantee (ADR-0012, the safe carve-out of the v1 folder-removal ban):
      // a folder trash may remove a husk of empty subfolders in one call, but must never
      // delete a note. Refuse the moment any file lives anywhere under it, naming the
      // blockers so the model can move or trash them first. Any same-batch move out of
      // this folder has already applied (ordered before folder trashes), so a husk emptied
      // this turn passes here.
      const { files, folders } = collectFolderSubtree(folder);
      if (files.length > 0) {
        throw new Error(nonEmptyFolderMessage(op.path, files));
      }
      await app.fileManager.trashFile(folder);
      // Capture the emptied subtree so undo re-creates every husk folder, not just the root.
      return inverseOf(op, { folderSubtree: folders });
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

/** Cap on note paths listed in a non-empty-folder refusal, so a large folder can't flood context. */
const MAX_LISTED_BLOCKERS = 20;

/**
 * The refusal thrown when a folder trash is blocked by notes inside it (ADR-0012).
 * Lists the offending note paths (capped) so the model can move or trash exactly
 * those and retry, instead of blindly probing the subtree one folder at a time.
 */
function nonEmptyFolderMessage(path: string, files: string[]): string {
  const shown = files.slice(0, MAX_LISTED_BLOCKERS);
  const list = shown.map((f) => `  - ${f}`).join("\n");
  const more = files.length > shown.length ? `\n  …and ${files.length - shown.length} more` : "";
  const count = `${files.length} note${files.length === 1 ? "" : "s"}`;
  return (
    `folder "${path}" contains ${count}; only folders with no notes can be trashed ` +
    `(empty subfolders are fine). Move or trash these first, then trash the folder:\n${list}${more}`
  );
}

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

/**
 * Lenient, overlay-aware in-loop validation for vault-op tool calls.
 *
 * Catches what the model can fix *now* (bad types, an overwrite of a folder, a
 * move whose destination already exists) and returns a self-correcting error in
 * the established style. The *authoritative* check is the apply-time pre-flight
 * (plan.ts); these validators are a courtesy to the model. Pure: existence is
 * resolved through an injected resolver (overlay ?? disk).
 */

import type { PathState } from "../../vault-ops/types";
import {
  escapesVault,
  isReservedConfigPath,
  outsideVaultMessage,
  reservedConfigMessage,
} from "../../vault-ops/pathSafety";
import { hasWritableExtension, unsupportedTypeMessage } from "./writableFileTypes";

type ValidationOk<T> = { ok: true; args: T };
type ValidationErr = { ok: false; error: string };
export type ValidationResult<T> = ValidationOk<T> | ValidationErr;

const ok = <T>(args: T): ValidationOk<T> => ({ ok: true, args });
const err = (error: string): ValidationErr => ({ ok: false, error });

/** Resolves a path's state against the overlay, then disk (overlay.ts). */
export type ResolvePath = (path: string) => PathState;

export interface WriteFileArgs {
  path: string;
  content: string;
}
export interface CreateDirectoryArgs {
  path: string;
}

/**
 * `create_directory` has a third outcome the others don't: the folder already
 * exists, so there is nothing to create, neither an error nor a reviewable op
 * (idempotency guard). `satisfied` carries a benign message for the model.
 */
export type CreateDirectoryResult =
  | ValidationOk<CreateDirectoryArgs>
  | { ok: true; satisfied: true; path: string; message: string }
  | ValidationErr;
export interface MoveFileArgs {
  from: string;
  to: string;
}
export interface TrashFileArgs {
  path: string;
}
export interface MoveFolderArgs {
  from: string;
  to: string;
}
export interface TrashFolderArgs {
  path: string;
}
export interface ReplaceInVaultArgs {
  search: string;
  replace: string;
  /** Optional folder scope; undefined ⇒ whole vault. */
  path?: string;
  caseSensitive: boolean;
  wholeWord: boolean;
}

export function validateWriteFile(
  args: Record<string, unknown>,
  resolve: ResolvePath,
  configDir: string,
): ValidationResult<WriteFileArgs> {
  if (typeof args.path !== "string" || args.path.trim() === "") {
    return err("path must be a non-empty string.");
  }
  if (escapesVault(args.path)) return err(outsideVaultMessage(args.path));
  if (isReservedConfigPath(args.path, configDir)) return err(reservedConfigMessage(args.path, configDir));
  if (typeof args.content !== "string") {
    return err("content must be a string. Got: " + typeof args.content);
  }
  if (resolve(args.path) === "dir") {
    return err(`"${args.path}" is a folder, choose a file path, or use create_directory.`);
  }
  // Allowlist the file type: write_file authors Obsidian documents only, so a
  // forgotten extension, a non-document type, or an executable/script (.bat, .exe …)
  // is refused before any op is created, for create and overwrite alike. Checked
  // after the folder branch so a folder path still gets the create_directory hint.
  if (!hasWritableExtension(args.path)) return err(unsupportedTypeMessage(args.path));
  return ok({ path: args.path, content: args.content });
}

export function validateCreateDirectory(
  args: Record<string, unknown>,
  resolve: ResolvePath,
  configDir: string,
): CreateDirectoryResult {
  if (typeof args.path !== "string" || args.path.trim() === "") {
    return err("path must be a non-empty string.");
  }
  if (escapesVault(args.path)) return err(outsideVaultMessage(args.path));
  if (isReservedConfigPath(args.path, configDir)) return err(reservedConfigMessage(args.path, configDir));
  const state = resolve(args.path);
  if (state === "file") {
    return err(`"${args.path}" is a file, choose a folder path.`);
  }
  if (state === "dir") {
    // Already a folder, not applied; tell the model it's done, calmly.
    return {
      ok: true,
      satisfied: true,
      path: args.path,
      message: `"${args.path}" already exists, nothing to create.`,
    };
  }
  return ok({ path: args.path });
}

export function validateMoveFile(
  args: Record<string, unknown>,
  resolve: ResolvePath,
  configDir: string,
): ValidationResult<MoveFileArgs> {
  if (typeof args.from !== "string" || args.from.trim() === "") {
    return err("from must be a non-empty string.");
  }
  if (typeof args.to !== "string" || args.to.trim() === "") {
    return err("to must be a non-empty string.");
  }
  if (escapesVault(args.from)) return err(outsideVaultMessage(args.from));
  if (escapesVault(args.to)) return err(outsideVaultMessage(args.to));
  // Refuse a move *into* the config subtree (the destination is the write target),
  // the same defense-in-depth guard as write_file. The source is intentionally not
  // guarded: it must already exist as a vault file, and relocating one out of the
  // config dir is not a write into it.
  if (isReservedConfigPath(args.to, configDir)) return err(reservedConfigMessage(args.to, configDir));
  // Hold the write_file allowlist on the destination too, so a move can't launder a
  // blessed file (note.md) into a forbidden type (note.bat), the same invariant,
  // enforced at every door a model can introduce an extension. Only the destination
  // is constrained; the source already exists in the vault.
  if (!hasWritableExtension(args.to)) return err(unsupportedTypeMessage(args.to));
  if (args.from === args.to) {
    return err("from and to are the same path, nothing to move.");
  }
  if (resolve(args.from) === "absent") {
    return err(`source "${args.from}" does not exist.`);
  }
  if (resolve(args.to) !== "absent") {
    return err(`destination "${args.to}" already exists, choose a new name.`);
  }
  return ok({ from: args.from, to: args.to });
}

export function validateMoveFolder(
  args: Record<string, unknown>,
  resolve: ResolvePath,
  configDir: string,
): ValidationResult<MoveFolderArgs> {
  if (typeof args.from !== "string" || args.from.trim() === "") {
    return err("from must be a non-empty string.");
  }
  if (typeof args.to !== "string" || args.to.trim() === "") {
    return err("to must be a non-empty string.");
  }
  if (escapesVault(args.from)) return err(outsideVaultMessage(args.from));
  if (escapesVault(args.to)) return err(outsideVaultMessage(args.to));
  // Refuse a move *into* the config subtree (the destination is the write target), the
  // same defense-in-depth guard as move_file. The source is not guarded: relocating a
  // folder out of the config dir is not a write into it.
  if (isReservedConfigPath(args.to, configDir)) return err(reservedConfigMessage(args.to, configDir));
  // No document-extension allowlist here: a folder has no extension. The vault-boundary
  // and reserved-config guards above are what keep a folder move in bounds.
  if (args.from === args.to) {
    return err("from and to are the same path, nothing to move.");
  }
  const fromState = resolve(args.from);
  if (fromState === "absent") return err(`source folder "${args.from}" does not exist.`);
  if (fromState === "file") {
    return err(`"${args.from}" is a file, use move_file to move a note.`);
  }
  if (resolve(args.to) !== "absent") {
    return err(`destination "${args.to}" already exists, choose a new name.`);
  }
  return ok({ from: args.from, to: args.to });
}

export function validateTrashFolder(
  args: Record<string, unknown>,
  resolve: ResolvePath,
): ValidationResult<TrashFolderArgs> {
  if (typeof args.path !== "string" || args.path.trim() === "") {
    return err("path must be a non-empty string.");
  }
  if (escapesVault(args.path)) return err(outsideVaultMessage(args.path));
  const state = resolve(args.path);
  if (state === "absent") return err(`"${args.path}" does not exist.`);
  if (state === "file") {
    return err(`"${args.path}" is a file, use trash_file to trash a note.`);
  }
  // Emptiness is *not* checked here (this validator sees only path state, not the
  // folder's children): the empty-only guarantee is enforced authoritatively at apply
  // via folderIsEmpty, after any same-batch moves have emptied the husk.
  return ok({ path: args.path });
}

export function validateReplaceInVault(
  args: Record<string, unknown>,
): ValidationResult<ReplaceInVaultArgs> {
  if (typeof args.search !== "string" || args.search === "") {
    return err("search must be a non-empty string.");
  }
  if (typeof args.replace !== "string") {
    return err("replace must be a string. Got: " + typeof args.replace);
  }
  let path: string | undefined;
  if (args.path !== undefined && args.path !== null && args.path !== "") {
    if (typeof args.path !== "string") return err("path must be a string when provided.");
    // A scope path that escapes the vault is refused up front (same boundary guard as
    // the other write tools), not silently treated as "no matches".
    if (escapesVault(args.path)) return err(outsideVaultMessage(args.path));
    path = args.path;
  }
  if (args.caseSensitive !== undefined && typeof args.caseSensitive !== "boolean") {
    return err("caseSensitive must be a boolean when provided.");
  }
  if (args.wholeWord !== undefined && typeof args.wholeWord !== "boolean") {
    return err("wholeWord must be a boolean when provided.");
  }
  return ok({
    search: args.search,
    replace: args.replace,
    path,
    caseSensitive: args.caseSensitive === true,
    wholeWord: args.wholeWord === true,
  });
}

export function validateTrashFile(
  args: Record<string, unknown>,
  resolve: ResolvePath,
): ValidationResult<TrashFileArgs> {
  if (typeof args.path !== "string" || args.path.trim() === "") {
    return err("path must be a non-empty string.");
  }
  if (escapesVault(args.path)) return err(outsideVaultMessage(args.path));
  const state = resolve(args.path);
  if (state === "absent") {
    return err(`"${args.path}" does not exist.`);
  }
  if (state === "dir") {
    // Files-only in v1, folder removal is too blunt for an agent.
    return err(`"${args.path}" is a folder, trash_file targets files only.`);
  }
  return ok({ path: args.path });
}

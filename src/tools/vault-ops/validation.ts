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
import { escapesVault, outsideVaultMessage } from "../../vault-ops/pathSafety";

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
 * exists, so there is nothing to create — neither an error nor a reviewable op
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

export function validateWriteFile(
  args: Record<string, unknown>,
  resolve: ResolvePath,
): ValidationResult<WriteFileArgs> {
  if (typeof args.path !== "string" || args.path.trim() === "") {
    return err("path must be a non-empty string.");
  }
  if (escapesVault(args.path)) return err(outsideVaultMessage(args.path));
  if (typeof args.content !== "string") {
    return err("content must be a string. Got: " + typeof args.content);
  }
  if (resolve(args.path) === "dir") {
    return err(`"${args.path}" is a folder — choose a file path, or use create_directory.`);
  }
  return ok({ path: args.path, content: args.content });
}

export function validateCreateDirectory(
  args: Record<string, unknown>,
  resolve: ResolvePath,
): CreateDirectoryResult {
  if (typeof args.path !== "string" || args.path.trim() === "") {
    return err("path must be a non-empty string.");
  }
  if (escapesVault(args.path)) return err(outsideVaultMessage(args.path));
  const state = resolve(args.path);
  if (state === "file") {
    return err(`"${args.path}" is a file — choose a folder path.`);
  }
  if (state === "dir") {
    // Already a folder — not applied; tell the model it's done, calmly.
    return {
      ok: true,
      satisfied: true,
      path: args.path,
      message: `"${args.path}" already exists — nothing to create.`,
    };
  }
  return ok({ path: args.path });
}

export function validateMoveFile(
  args: Record<string, unknown>,
  resolve: ResolvePath,
): ValidationResult<MoveFileArgs> {
  if (typeof args.from !== "string" || args.from.trim() === "") {
    return err("from must be a non-empty string.");
  }
  if (typeof args.to !== "string" || args.to.trim() === "") {
    return err("to must be a non-empty string.");
  }
  if (escapesVault(args.from)) return err(outsideVaultMessage(args.from));
  if (escapesVault(args.to)) return err(outsideVaultMessage(args.to));
  if (args.from === args.to) {
    return err("from and to are the same path — nothing to move.");
  }
  if (resolve(args.from) === "absent") {
    return err(`source "${args.from}" does not exist.`);
  }
  if (resolve(args.to) !== "absent") {
    return err(`destination "${args.to}" already exists — choose a new name.`);
  }
  return ok({ from: args.from, to: args.to });
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
    // Files-only in v1 — folder removal is too blunt for an agent.
    return err(`"${args.path}" is a folder — trash_file targets files only.`);
  }
  return ok({ path: args.path });
}

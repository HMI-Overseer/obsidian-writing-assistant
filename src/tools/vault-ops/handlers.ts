import type { App } from "obsidian";
import type { ToolCall, ToolResult } from "../types";
import type { VaultOperation } from "../../vault-ops/types";
import { diskState } from "../../vault-ops/apply";
import { toolFailure } from "../toolFailure";
import { VAULT_OPS_TOOL_NAMES } from "./definition";
import { buildOverlay, makeResolver, type PendingOverlay } from "./overlay";
import { toVaultOperations, type ConversionProbes } from "./conversion";
import {
  validateCreateDirectory,
  validateMoveFile,
  validateTrashFile,
  validateWriteFile,
} from "./validation";

/**
 * Context for in-loop vault-op execution. Vault ops operate on
 * arbitrary paths, so unlike edit tools they need no active file — only the app
 * and the per-turn pending overlay, rebuilt each round from accumulated ops.
 */
export interface VaultOpContext {
  app: App;
  overlay: PendingOverlay;
}

/**
 * Execute a vault-op tool inside the tool loop and return a result for the model.
 *
 * Mirrors `executeEditTool`: vault ops are *validated only* in the loop (lenient,
 * overlay-aware) so the model gets immediate, self-correcting feedback and
 * can recover within the turn. Nothing touches disk here; the proposal is built
 * and applied at finalization. Pre-flight (plan.ts) is the real
 * safety guarantee — these validators are a courtesy to the model.
 */
export function executeVaultOpTool(call: ToolCall, ctx: VaultOpContext): ToolResult {
  if (!VAULT_OPS_TOOL_NAMES.has(call.name)) {
    return unknownVaultOpTool(call.name);
  }

  const resolve = makeResolver(ctx.overlay, (path) => diskState(ctx.app, path));

  switch (call.name) {
    case "write_file": {
      const v = validateWriteFile(call.arguments, resolve);
      if (!v.ok) return fail("write_file", v.error);
      const verb = resolve(v.args.path) === "file" ? "Overwrite of" : "New file";
      return queued(`${verb} "${v.args.path}"`);
    }
    case "create_directory": {
      const v = validateCreateDirectory(call.arguments, resolve);
      if (!v.ok) return fail("create_directory", v.error);
      // Already a folder: a benign, non-error acknowledgement — no review row
      // is emitted for it at finalization (conversion drops the satisfied op).
      if ("satisfied" in v) return { content: v.message, isReadOnly: false };
      return queued(`New folder "${v.args.path}"`);
    }
    case "move_file": {
      const v = validateMoveFile(call.arguments, resolve);
      if (!v.ok) return fail("move_file", v.error);
      return queued(`Move "${v.args.from}" → "${v.args.to}"`);
    }
    case "trash_file": {
      const v = validateTrashFile(call.arguments, resolve);
      if (!v.ok) return fail("trash_file", v.error);
      return queued(`Trash "${v.args.path}"`);
    }
    default:
      return unknownVaultOpTool(call.name);
  }
}

function unknownVaultOpTool(name: string): ToolResult {
  return toolFailure({
    kind: "invalid-args",
    what: `unknown vault operation tool "${name}"`,
    recovery: "call one of the advertised vault operation tools instead",
    isReadOnly: false,
  });
}

/**
 * Build the per-turn pending overlay from vault-op calls accumulated
 * in prior rounds, so a later round's `move_file A→B` sees an earlier round's
 * `write_file A`. Calls are converted progressively, each against the overlay
 * built from the ops before it, so dependent ops chain correctly.
 */
export function buildPendingOverlay(app: App, vaultOpCalls: ToolCall[]): PendingOverlay {
  const ops: VaultOperation[] = [];
  for (const call of vaultOpCalls) {
    const probes = makeConversionProbes(app, buildOverlay(ops));
    const { ops: converted } = toVaultOperations([call], probes);
    ops.push(...converted);
  }
  return buildOverlay(ops);
}

/** Conversion probes backed by the live vault, overlaid with pending state. */
function makeConversionProbes(app: App, overlay: PendingOverlay): ConversionProbes {
  return {
    resolve: makeResolver(overlay, (path) => diskState(app, path)),
    // Fingerprints/snapshots only matter at finalization; for overlay building
    // we care only about path *state*, so these can stay cheap and empty.
    fingerprint: () => null,
    readContent: () => null,
  };
}

function queued(summary: string): ToolResult {
  return { content: `${summary} queued for review.`, isReadOnly: false };
}

function fail(tool: string, error: string): ToolResult {
  return toolFailure({
    kind: "invalid-args",
    what: `invalid ${tool} arguments: ${error}`,
    isReadOnly: false,
  });
}

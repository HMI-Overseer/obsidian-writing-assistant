/**
 * Convert vault-op tool calls into VaultOperations.
 *
 * `write_file` resolves to `create` or `overwrite` from path existence, and `move` /
 * `trash` resolve to their file or folder kind the same way; the model never sets a
 * flag. Destructive ops capture their TargetFingerprint and a file trash captures a
 * content snapshot for its inverse. Pure: existence and disk reads are injected as
 * probes. Includes the max_tokens truncation guard.
 */

import type { ToolCall } from "../types";
import type { PathState, TargetFingerprint, VaultOperation } from "../../vault-ops/types";
import {
  validateCreateDirectory,
  validateMove,
  validateReplaceInVault,
  validateTrash,
  validateWriteFile,
} from "./validation";

/** Precomputed per-file change set for a `replace_in_vault` call (see preScanReplacements). */
export interface ReplaceScanResult {
  targets: Array<{ path: string; content: string; expect: TargetFingerprint; count: number }>;
  occurrences: number;
}

export interface ConversionProbes {
  /** Existence resolved against overlay ?? disk. */
  resolve: (path: string) => PathState;
  /** Live fingerprint for a destructive op's conflict guard; null if absent. */
  fingerprint: (path: string) => TargetFingerprint | null;
  /** Current content, captured as the trash snapshot for undo; null if absent. */
  readContent: (path: string) => string | null;
  /** Live `app.vault.configDir`, used to refuse writes into the config subtree. */
  configDir: string;
  /**
   * Precomputed targets for a `replace_in_vault` call, keyed by tool-call id. Null
   * when there is no scan in this context (e.g. overlay building, where a replace is
   * a no-op for path state) or when nothing matched. The scan is async, so it runs
   * before conversion ({@link ../../vault-ops/proposalSupport.preScanReplacements}).
   */
  replaceTargets: (callId: string) => ReplaceScanResult | null;
}

export interface ConversionError {
  toolCallId: string;
  toolName: string;
  error: string;
}

export interface ConversionResult {
  ops: VaultOperation[];
  /** Source tool-call id per op, index-aligned with `ops`, links each op back
   *  to the model tool call (and thus its timeline step) it came from. */
  sources: string[];
  /** Index-aligned with `ops`: true where the op is an already-satisfied no-op
   *  (e.g. create_directory on an existing folder). Such ops are shown on their
   *  timeline step as an informational note and are never applied. */
  satisfied: boolean[];
  errors: ConversionError[];
}

/** Used when a destructive target vanished between probe and capture (pre-flight will catch it). */
const MISSING_FINGERPRINT: TargetFingerprint = { mtime: 0, size: 0 };

export function toVaultOperations(
  toolCalls: ToolCall[],
  probes: ConversionProbes,
  options: { stoppedForMaxTokens?: boolean } = {},
): ConversionResult {
  const ops: VaultOperation[] = [];
  const sources: string[] = [];
  const satisfied: boolean[] = [];
  const errors: ConversionError[] = [];
  const lastIndex = toolCalls.length - 1;

  toolCalls.forEach((tc, index) => {
    const fail = (error: string) =>
      errors.push({ toolCallId: tc.id, toolName: tc.name, error });
    // Keep `ops`, `sources`, and `satisfied` index-aligned: every emit records
    // the source tc.id and whether the op is an already-satisfied no-op.
    const emit = (op: VaultOperation, isSatisfied = false) => {
      ops.push(op);
      sources.push(tc.id);
      satisfied.push(isSatisfied);
    };

    // Every `case` below is a **tool name**. Two of them, `move` and `trash`, are also
    // the spelling of a `VaultOperation["kind"]` emitted inside the very same arms; the
    // switch is on `tc.name` and never on `op.kind`.
    switch (tc.name) {
      case "write_file": {
        // Truncation guard: a write_file whose generation hit max_tokens
        // may carry a partial file, refuse rather than persist a truncated note.
        // Truncation, not size, is the real hazard, so there is no size cap.
        if (options.stoppedForMaxTokens && index === lastIndex) {
          fail(
            "write_file was cut off by the output token limit, its content may be " +
              "incomplete. Re-issue the call with the complete file content.",
          );
          return;
        }
        const v = validateWriteFile(tc.arguments, probes.resolve, probes.configDir);
        if (!v.ok) return fail(v.error);
        if (probes.resolve(v.args.path) === "file") {
          emit({
            kind: "overwrite",
            path: v.args.path,
            content: v.args.content,
            expect: probes.fingerprint(v.args.path) ?? MISSING_FINGERPRINT,
          });
        } else {
          emit({ kind: "create", path: v.args.path, content: v.args.content });
        }
        return;
      }
      case "create_directory": {
        const v = validateCreateDirectory(tc.arguments, probes.resolve, probes.configDir);
        if (!v.ok) return fail(v.error);
        // Folder already exists (idempotency guard): emit a flagged no-op so the
        // timeline can show "directory already exists", but it is never applied.
        if ("satisfied" in v) {
          emit({ kind: "createDir", path: v.path }, true);
          return;
        }
        emit({ kind: "createDir", path: v.args.path });
        return;
      }
      case "move": {
        const v = validateMove(tc.arguments, probes.resolve, probes.configDir);
        if (!v.ok) return fail(v.error);
        if (v.args.isFolder) {
          // A folder move needs no fingerprint (existence guard) and no content snapshot.
          emit({ kind: "moveFolder", from: v.args.from, to: v.args.to });
          return;
        }
        emit({
          kind: "move",
          from: v.args.from,
          to: v.args.to,
          expect: probes.fingerprint(v.args.from) ?? MISSING_FINGERPRINT,
        });
        return;
      }
      case "trash": {
        const v = validateTrash(tc.arguments, probes.resolve);
        if (!v.ok) return fail(v.error);
        if (v.args.isFolder) {
          // An empty folder husk carries neither fingerprint nor snapshot: its inverse
          // is a createDir, and the subtree it re-creates is captured at apply time.
          emit({ kind: "trashFolder", path: v.args.path });
          return;
        }
        emit({
          kind: "trash",
          path: v.args.path,
          expect: probes.fingerprint(v.args.path) ?? MISSING_FINGERPRINT,
          snapshot: probes.readContent(v.args.path) ?? "",
        });
        return;
      }
      case "replace_in_vault": {
        const v = validateReplaceInVault(tc.arguments);
        if (!v.ok) return fail(v.error);
        const found = probes.replaceTargets(tc.id);
        // No matches, or no scan in this context (overlay building) → emit nothing.
        // A zero-match replace is not an error; the model learns it via the op's
        // disposition / the handler's acknowledgement, so the proposal just omits it.
        if (!found || found.targets.length === 0) return;
        emit({
          kind: "replaceInVault",
          search: v.args.search,
          replace: v.args.replace,
          caseSensitive: v.args.caseSensitive,
          wholeWord: v.args.wholeWord,
          targets: found.targets,
          occurrences: found.occurrences,
        });
        return;
      }
      default:
        fail(`unknown vault-op tool "${tc.name}".`);
    }
  });

  return { ops, sources, satisfied, errors };
}

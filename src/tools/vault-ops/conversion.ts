/**
 * Convert vault-op tool calls into VaultOperations (spec §6 step 1).
 *
 * `write_file` resolves to `create` or `overwrite` from path existence — the
 * model never sets a flag. Destructive ops capture their TargetFingerprint and
 * trash captures a content snapshot for its inverse. Pure: existence and disk
 * reads are injected as probes. Includes the max_tokens truncation guard (§6 1a).
 */

import type { ToolCall } from "../types";
import type { PathState, TargetFingerprint, VaultOperation } from "../../vault-ops/types";
import {
  validateCreateDirectory,
  validateMoveFile,
  validateTrashFile,
  validateWriteFile,
} from "./validation";

export interface ConversionProbes {
  /** Existence resolved against overlay ?? disk. */
  resolve: (path: string) => PathState;
  /** Live fingerprint for a destructive op's conflict guard; null if absent. */
  fingerprint: (path: string) => TargetFingerprint | null;
  /** Current content, captured as the trash snapshot for undo; null if absent. */
  readContent: (path: string) => string | null;
}

export interface ConversionError {
  toolCallId: string;
  toolName: string;
  error: string;
}

export interface ConversionResult {
  ops: VaultOperation[];
  /** Source tool-call id per op, index-aligned with `ops` — links each op back
   *  to the model tool call (and thus its timeline step) it came from. */
  sources: string[];
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
  const errors: ConversionError[] = [];
  const lastIndex = toolCalls.length - 1;

  toolCalls.forEach((tc, index) => {
    const fail = (error: string) =>
      errors.push({ toolCallId: tc.id, toolName: tc.name, error });
    // Keep `ops` and `sources` index-aligned: every emit records the source tc.id.
    const emit = (op: VaultOperation) => {
      ops.push(op);
      sources.push(tc.id);
    };

    switch (tc.name) {
      case "write_file": {
        // Truncation guard (§6 1a): a write_file whose generation hit max_tokens
        // may carry a partial file — refuse rather than persist a truncated note.
        // Truncation, not size, is the real hazard, so there is no size cap.
        if (options.stoppedForMaxTokens && index === lastIndex) {
          fail(
            "write_file was cut off by the output token limit — its content may be " +
              "incomplete. Re-issue the call with the complete file content.",
          );
          return;
        }
        const v = validateWriteFile(tc.arguments, probes.resolve);
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
        const v = validateCreateDirectory(tc.arguments, probes.resolve);
        if (!v.ok) return fail(v.error);
        emit({ kind: "createDir", path: v.args.path });
        return;
      }
      case "move_file": {
        const v = validateMoveFile(tc.arguments, probes.resolve);
        if (!v.ok) return fail(v.error);
        emit({
          kind: "move",
          from: v.args.from,
          to: v.args.to,
          expect: probes.fingerprint(v.args.from) ?? MISSING_FINGERPRINT,
        });
        return;
      }
      case "trash_file": {
        const v = validateTrashFile(tc.arguments, probes.resolve);
        if (!v.ok) return fail(v.error);
        emit({
          kind: "trash",
          path: v.args.path,
          expect: probes.fingerprint(v.args.path) ?? MISSING_FINGERPRINT,
          snapshot: probes.readContent(v.args.path) ?? "",
        });
        return;
      }
      default:
        fail(`unknown vault-op tool "${tc.name}".`);
    }
  });

  return { ops, sources, errors };
}

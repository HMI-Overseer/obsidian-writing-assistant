import type { App } from "obsidian";
import { normalizePath } from "obsidian";
import type { ToolCall } from "../tools/types";
import { generateId } from "../utils";
import { findReplaceTargets } from "../tools/vault-ops/replaceScan";
import { validateReplaceInVault } from "../tools/vault-ops/validation";
import type { ReplaceScanResult } from "../tools/vault-ops/conversion";
import { readContentOrNull } from "./apply";
import type { ApprovalPosture } from "../shared/types";
import { resolveGate, type Gate, type VaultOpPolicy } from "./gateway";
import { backlinkCount } from "./metadata";
import { isReservedConfigPath } from "./pathSafety";
import { summarizeOp } from "./summary";
import type { ReviewableVaultOp, VaultOperation } from "./types";

/**
 * Pre-read the on-disk content of every `trash` call so the synchronous
 * conversion can stay synchronous: a trashed file's snapshot is what its inverse
 * re-creates on undo. Keyed by normalized path; non-trash calls and unreadable
 * paths contribute nothing, which is also how `trash`'s folder pathway is handled:
 * a folder has no content to read, so `readContentOrNull` returns null for it and
 * the folder trash carries no snapshot, exactly as it did under its own tool name.
 * Shared by both proposal builders (the one-shot finalize path and the in-loop
 * {@link LiveVaultReview} path).
 */
export async function preReadTrashSnapshots(
  app: App,
  calls: ToolCall[],
): Promise<Map<string, string>> {
  const snapshots = new Map<string, string>();
  for (const tc of calls) {
    if (tc.name === "trash" && typeof tc.arguments.path === "string") {
      const content = await readContentOrNull(app, tc.arguments.path);
      if (content !== null) snapshots.set(normalizePath(tc.arguments.path), content);
    }
  }
  return snapshots;
}

/**
 * Pre-scan every `replace_in_vault` call's matches before the synchronous conversion,
 * mirroring {@link preReadTrashSnapshots}: the scan reads many files (async) and
 * computes each matched file's full replaced content plus the fingerprint captured at
 * read time (its conflict guard). Returns the per-file targets keyed by tool-call id;
 * calls with no matches (or invalid args) contribute nothing. Config-subtree files are
 * excluded, so a replace can never rewrite plugin/app data. Shared by both proposal
 * builders (the finalize path and the in-loop {@link LiveVaultReview} path).
 */
export async function preScanReplacements(
  app: App,
  calls: ToolCall[],
): Promise<Map<string, ReplaceScanResult>> {
  const out = new Map<string, ReplaceScanResult>();
  const configDir = app.vault.configDir;

  for (const tc of calls) {
    if (tc.name !== "replace_in_vault") continue;
    const v = validateReplaceInVault(tc.arguments);
    if (!v.ok) continue; // invalid args surface as a handler/conversion failure, not a scan

    const scope = v.args.path ? normalizePath(v.args.path) : "";
    const files = app.vault
      .getMarkdownFiles()
      .map((f) => f.path)
      .filter((p) => scope === "" || p === scope || p.startsWith(`${scope}/`))
      .filter((p) => !isReservedConfigPath(p, configDir));

    // Read content and capture the fingerprint from the *same* stat, so a file that
    // changes after the scan is caught by pre-flight (live fingerprint ≠ this expect),
    // never silently clobbered by the precomputed content.
    const read = new Map<string, { content: string; mtime: number; size: number }>();
    await Promise.all(
      files.map(async (p) => {
        const file = app.vault.getFileByPath(p);
        if (!file) return;
        const content = await app.vault.cachedRead(file);
        read.set(p, { content, mtime: file.stat.mtime, size: file.stat.size });
      }),
    );

    const results = findReplaceTargets(files, (p) => read.get(p)?.content ?? null, {
      search: v.args.search,
      replace: v.args.replace,
      caseSensitive: v.args.caseSensitive,
      wholeWord: v.args.wholeWord,
    });
    if (results.length === 0) continue;

    let occurrences = 0;
    const targets = results.map((r) => {
      occurrences += r.count;
      const fp = read.get(r.path);
      return {
        path: r.path,
        content: r.content,
        expect: { mtime: fp?.mtime ?? 0, size: fp?.size ?? 0 },
        count: r.count,
      };
    });
    out.set(tc.id, { targets, occurrences });
  }
  return out;
}

/**
 * The shared gating contract for a converted op (the security-sensitive seam, now
 * one implementation for both proposal builders). An already-satisfied no-op is
 * forced to `auto` (never gated, never applied); everything else runs through
 * {@link resolveGate}. `autoConsumed` is true only when this op newly spends a slot
 * of the per-turn auto budget, so each caller bumps its own `autoSoFar` in exactly
 * the cases the old inline `gate === "auto" && !isSatisfied` did.
 */
export function gateConvertedOp(
  op: VaultOperation,
  isSatisfied: boolean,
  policy: VaultOpPolicy,
  autoSoFar: number,
  posture: ApprovalPosture = "ask",
): { gate: Gate; autoConsumed: boolean } {
  const gate = isSatisfied ? "auto" : resolveGate(op, policy, autoSoFar, posture);
  return { gate, autoConsumed: gate === "auto" && !isSatisfied };
}

/**
 * Build a {@link ReviewableVaultOp} from a converted op and its already-decided
 * gate (`deny` is handled by the caller and never reaches here). A move op carries
 * its {@link backlinkCount} as `linkImpact`. One implementation for both builders.
 */
export function buildReviewableOp(
  app: App,
  op: VaultOperation,
  gate: "auto" | "ask",
  isSatisfied: boolean,
  sourceToolCallId: string,
): ReviewableVaultOp {
  const reviewable: ReviewableVaultOp = {
    id: generateId(),
    op,
    gate,
    status: isSatisfied ? "satisfied" : "pending",
    summary: summarizeOp(op),
    sourceToolCallId,
  };
  if (op.kind === "move") reviewable.linkImpact = backlinkCount(app, op.from);
  return reviewable;
}

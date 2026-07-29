/**
 * Disposition vocabulary for vault ops, the real outcome of a proposed op, fed
 * back to the model as its tool result (in-loop-tool-approval-blocking-flow).
 *
 * One vocabulary, derived from the proposal's single resolved {@link VaultOpStatus}
 * (the same state the timeline UI renders), so the tool result can never assert an
 * outcome the UI doesn't hold. Pure, no Obsidian, no disk, so it is unit-testable.
 */

import { assertNever } from "../utils";
import type { VaultOperation } from "./types";
import type { MatchType } from "../editing/editTypes";

/**
 * The fate of one op as reported back to the model:
 *   - `auto-applied`, applied in-loop with no click (auto gate).
 *   - `applied`, the user approved and it applied.
 *   - `declined`, the user declined it.
 *   - `failed`, apply (or pre-flight) failed; carries a reason.
 *   - `satisfied`, an already-satisfied no-op (e.g. create_directory on an
 *                      existing folder); never applied.
 *   - `cancelled`, the turn was interrupted before the user decided; the op is
 *                      left pending review.
 */
export type VaultOpDisposition =
  | "auto-applied"
  | "applied"
  | "declined"
  | "failed"
  | "satisfied"
  | "cancelled";

/** Past-tense verb for an applied op, e.g. "Created", "Overwrote". */
function appliedVerb(op: VaultOperation): string {
  switch (op.kind) {
    case "create":
      return "Created";
    case "overwrite":
      return "Overwrote";
    case "createDir":
      return "Created folder";
    case "move":
      return "Moved";
    case "trash":
      return "Trashed";
    case "moveFolder":
      return "Moved folder";
    case "trashFolder":
      return "Trashed folder";
    case "replaceInVault":
      return "Replaced";
  }
}

/** Lower-case infinitive for a failure line, e.g. "create", "overwrite". */
function actionVerb(op: VaultOperation): string {
  switch (op.kind) {
    case "create":
      return "create";
    case "overwrite":
      return "overwrite";
    case "createDir":
      return "create folder";
    case "move":
      return "move";
    case "trash":
      return "trash";
    case "moveFolder":
      return "move folder";
    case "trashFolder":
      return "trash folder";
    case "replaceInVault":
      return "replace";
  }
}

/** Plural-aware "N note(s)" for a replace's target count. */
function noteCountLabel(count: number): string {
  return `${count} note${count === 1 ? "" : "s"}`;
}

/** The target rendered in a message: move shows both endpoints, a replace its terms + reach. */
function target(op: VaultOperation): string {
  if (op.kind === "move" || op.kind === "moveFolder") return `"${op.from}" → "${op.to}"`;
  if (op.kind === "replaceInVault") {
    return `"${op.search}" → "${op.replace}" in ${noteCountLabel(op.targets.length)} (${op.occurrences} matches)`;
  }
  return `"${op.path}"`;
}

/**
 * Append the user's decline guidance to a decline message as one distinct
 * sentence (RFC-0012). The single place the three disposition builders compose
 * it, so their wording cannot drift.
 *
 * Guidance is strictly additive: absent, empty, and whitespace-only all return
 * the base message byte for byte, so a plain "no" reads exactly as it always
 * has. A trailing period the user typed is stripped, the same uniform terminal
 * punctuation every model-facing sentence here gets.
 *
 * A decline is a policy outcome, not a failure, so this never reaches
 * `failure.recovery` (ADR-0021) and never flips `isError`.
 */
export function withDeclineGuidance(message: string, guidance?: string): string {
  const trimmed = guidance?.trim() ?? "";
  if (trimmed === "") return message;
  const sentence = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  return `${message} The user's guidance: ${sentence}.`;
}

/**
 * Build the tool-result message for a resolved op. The model reads this as the
 * real outcome of its call, replacing the old fixed "queued for review" string.
 *
 * `guidance` is the user's free text from a drawer decline and is honoured on
 * that branch only ({@link withDeclineGuidance}).
 */
export function dispositionMessage(
  op: VaultOperation,
  disposition: VaultOpDisposition,
  reason?: string,
  guidance?: string,
): string {
  switch (disposition) {
    case "auto-applied":
      return `${appliedVerb(op)} ${target(op)} (auto-applied).`;
    case "applied":
      return `${appliedVerb(op)} ${target(op)}.`;
    case "declined":
      return withDeclineGuidance(
        `Declined by user, ${target(op)} was not changed.`,
        guidance,
      );
    case "failed":
      // "Error:" prefix so the model reads this as a failure on the text-only loop
      // channel, the same signal the read tools and the system prompt rely on.
      return `Error: could not ${actionVerb(op)} ${target(op)}, ${reason ?? "the operation failed"}.`;
    case "satisfied":
      return op.kind === "createDir"
        ? `Folder ${target(op)} already exists; nothing to do.`
        : `${target(op)} already satisfied; nothing to do.`;
    case "cancelled":
      return `Generation stopped before you decided, ${target(op)} is still pending review.`;
    default:
      return assertNever(disposition);
  }
}

/** Which edit tool produced the disposition, shapes the model-facing wording. */
export type EditOpKind = "edit" | "frontmatter" | "insert";

/**
 * The match tier, in plain words, for an *applied* edit, the diagnostic the channel
 * computes and otherwise discards. Returns null for `exact` (a clean match teaches
 * nothing) and `none` (only reached on failure), so success messages stay quiet
 * unless the search text was loose enough to be worth tightening next time.
 */
function appliedMatchPhrase(matchType: MatchType): string | null {
  switch (matchType) {
    case "whitespace":
      return "whitespace-corrected match";
    case "fuzzy":
      return "fuzzy match";
    case "exact":
    case "none":
      return null;
  }
}

/**
 * Build the tool-result message for a resolved in-document edit. Edits share the
 * vault-op {@link VaultOpDisposition} vocabulary (the model never sees a second
 * dialect) but read in edit terms. `failed` carries the honest reason, for a
 * confidence-0 no-match this is the self-correction prompt the model acts on.
 *
 * When `matchType` is supplied, an *applied* edit names how it matched (e.g.
 * "(fuzzy match)") so the model learns when its search text was sloppy. The phrase
 * can never assert a tier the engine didn't produce, it is derived from the same
 * resolved edit the apply used (one state, two consumers).
 *
 * `occurrenceCount` (> 1) names a *non-unique* search on an applied edit, so the model
 * learns it anchored the first of several identical passages and can add surrounding
 * context to target a specific one next time. This is the model-facing half of the
 * symptom-C signal (the user-facing half is the diff card's "1 of N" badge); it matters
 * most for an auto-applied edit, where there is no user click and the disposition is the
 * only channel that isn't silent.
 *
 * `guidance` is the user's free text from a drawer decline, honoured on that branch only
 * ({@link withDeclineGuidance}).
 */
export function editDispositionMessage(
  kind: EditOpKind,
  filePath: string,
  disposition: VaultOpDisposition,
  reason?: string,
  matchType?: MatchType,
  occurrenceCount?: number,
  guidance?: string,
): string {
  const tool =
    kind === "frontmatter" ? "update_frontmatter" : kind === "insert" ? "insert_into_note" : "propose_edit";
  const what = kind === "frontmatter" ? "frontmatter update" : kind === "insert" ? "insertion" : "edit";
  const t = `"${filePath}"`;

  // Compose the trailing "(…)" for an applied edit from the optional auto-applied
  // flag, the optional match phrase, and the optional multiplicity note, so they never
  // collide into "(a) (b)".
  const appliedSuffix = (autoFlag: boolean): string => {
    const flags: string[] = [];
    if (autoFlag) flags.push("auto-applied");
    const phrase = matchType ? appliedMatchPhrase(matchType) : null;
    if (phrase) flags.push(phrase);
    if (occurrenceCount !== undefined && occurrenceCount > 1) {
      flags.push(`first of ${occurrenceCount} matches`);
    }
    return flags.length > 0 ? ` (${flags.join(", ")})` : "";
  };

  switch (disposition) {
    case "auto-applied":
      return `Applied ${what} to ${t}${appliedSuffix(true)}.`;
    case "applied":
      return `Applied ${what} to ${t}${appliedSuffix(false)}.`;
    case "declined":
      return withDeclineGuidance(
        `Declined by user, ${what} to ${t} was not applied.`,
        guidance,
      );
    case "failed":
      // "Error:" prefix so the model reads this as a failure on the text-only loop
      // channel, the same signal the read tools and the system prompt rely on.
      return `Error: ${tool} did not apply to ${t}, ${reason ?? "the edit could not be resolved"}.`;
    case "satisfied":
      return `${t} already matches; nothing to change.`;
    case "cancelled":
      return `Generation stopped before you decided, ${what} to ${t} is still pending review.`;
    default:
      return assertNever(disposition);
  }
}

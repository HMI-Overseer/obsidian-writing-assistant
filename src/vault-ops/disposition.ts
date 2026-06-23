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
  }
}

/** The target rendered in a message, move shows both endpoints. */
function target(op: VaultOperation): string {
  return op.kind === "move" ? `"${op.from}" → "${op.to}"` : `"${op.path}"`;
}

/**
 * Build the tool-result message for a resolved op. The model reads this as the
 * real outcome of its call, replacing the old fixed "queued for review" string.
 */
export function dispositionMessage(
  op: VaultOperation,
  disposition: VaultOpDisposition,
  reason?: string,
): string {
  switch (disposition) {
    case "auto-applied":
      return `${appliedVerb(op)} ${target(op)} (auto-applied).`;
    case "applied":
      return `${appliedVerb(op)} ${target(op)}.`;
    case "declined":
      return `Declined by user, ${target(op)} was not changed.`;
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
export type EditOpKind = "edit" | "frontmatter";

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
 */
export function editDispositionMessage(
  kind: EditOpKind,
  filePath: string,
  disposition: VaultOpDisposition,
  reason?: string,
  matchType?: MatchType,
  occurrenceCount?: number,
): string {
  const tool = kind === "frontmatter" ? "update_frontmatter" : "propose_edit";
  const what = kind === "frontmatter" ? "frontmatter update" : "edit";
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
      return `Declined by user, ${what} to ${t} was not applied.`;
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

import { parseEditBlocks } from "../../editing/parseEditBlocks";
import { check, buildResultFromChecks } from "./checks";
import type { BenchmarkResult, BenchmarkTestCase, EvaluationCheck } from "./types";

/**
 * Prose evaluators for the annotation suite.
 *
 * Edit-block tests are scored by `evaluateEditRegions` in editScoring.ts;
 * this module covers tests where the expected response is prose.
 */

// ---------------------------------------------------------------------------
// State awareness
// ---------------------------------------------------------------------------

/** Language acknowledging a change was applied. */
const ACCEPT_SIGNALS = ["accepted", "applied", "kept", "reflected", "went through"];

/** Language acknowledging a change was not applied. */
const REJECT_SIGNALS = [
  "rejected",
  "not applied",
  "wasn't applied",
  "was not applied",
  "unchanged",
  "original",
  "declined",
  "was not",
  "wasn't",
  "isn't",
  "didn't",
];

/** References to the accepted opening-paragraph change. */
const OPENING_REFS = ["opening", "first change", "first edit", "first one", "dawn", "baker"];

/** References to the rejected fountain-paragraph change. */
const FOUNTAIN_REFS = ["fountain", "second change", "second edit", "second one", "children", "old woman"];

/** Splits prose into sentence-ish units (sentences, list items, lines). */
function sentenceUnits(response: string): string[] {
  return response
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function findPairedSentence(units: string[], refs: string[], signals: string[]): string | null {
  for (const unit of units) {
    const lower = unit.toLowerCase();
    if (refs.some((r) => lower.includes(r)) && signals.some((s) => lower.includes(s))) {
      return unit;
    }
  }
  return null;
}

/**
 * Test: "Awareness of current document state"
 *
 * The response must pair each change with its outcome, the opening change
 * with accepted language and the fountain change with rejected language,
 * within the same sentence or list item, so that merely mentioning the words
 * somewhere in the response doesn't pass.
 */
export function evaluateStateAwareness(
  response: string,
  _testCase: BenchmarkTestCase
): BenchmarkResult {
  const units = sentenceUnits(response);
  const evidence: string[] = [];
  const checks: EvaluationCheck[] = [];

  const acceptedSentence = findPairedSentence(units, OPENING_REFS, ACCEPT_SIGNALS);
  checks.push(
    check(
      "identifies-accepted",
      "Identifies the opening-paragraph change as applied",
      acceptedSentence !== null,
      acceptedSentence === null
        ? "no sentence pairs the opening/first change with accepted/applied language"
        : undefined
    )
  );
  if (acceptedSentence) evidence.push(`Accepted: "${acceptedSentence.slice(0, 120)}"`);

  const rejectedSentence = findPairedSentence(units, FOUNTAIN_REFS, REJECT_SIGNALS);
  checks.push(
    check(
      "identifies-rejected",
      "Identifies the fountain-paragraph change as not applied",
      rejectedSentence !== null,
      rejectedSentence === null
        ? "no sentence pairs the fountain/second change with rejected/unchanged language"
        : undefined
    )
  );
  if (rejectedSentence) evidence.push(`Rejected: "${rejectedSentence.slice(0, 120)}"`);

  // Informational: the user asked for a summary, so edit blocks are off-script.
  const { blocks } = parseEditBlocks(response);
  checks.push(
    check(
      "prose-only",
      "Responded with prose only (no edit blocks)",
      blocks.length === 0,
      blocks.length === 0
        ? undefined
        : `emitted ${blocks.length} edit block(s) although the user asked for a summary`,
      false
    )
  );

  if (evidence.length === 0) evidence.push(`Response: "${response.slice(0, 200)}"`);

  return buildResultFromChecks(
    checks,
    evidence,
    "Correctly paired the accepted and rejected changes with their outcomes."
  );
}

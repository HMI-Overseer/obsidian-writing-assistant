import type { ToolCall } from "../../tools/types";
import { check, buildResultFromChecks } from "./checks";
import { assessSearchTexts, describeAssessment } from "./editScoring";
import type { BlockAssessment } from "./editScoring";
import type { BenchmarkResult, BenchmarkTestCase, EvaluationCheck } from "./types";

/**
 * Check-based evaluators for the edit-tools suite.
 *
 * Beyond verifying that the right tool was called with well-formed arguments,
 * every edit search argument is resolved against the fixture document
 * with the real diff engine, a call whose search text would not match the
 * document fails, exactly as it would in real use.
 */

// =========================================================================
// Helpers
// =========================================================================

function formatToolCall(tc: ToolCall): string {
  const args = JSON.stringify(tc.arguments);
  const preview = args.length > 120 ? args.slice(0, 120) + "..." : args;
  return `${tc.name}(${preview})`;
}

const PRODUCED_CALLS = "Produced tool calls";

/** Result for the universal first check failing: the model never called a tool. */
function noToolCallsResult(response: string): BenchmarkResult {
  return buildResultFromChecks(
    [check("produced-calls", PRODUCED_CALLS, false, "the model responded with text instead of calling a tool")],
    [response.slice(0, 200) || "(empty response)"],
    ""
  );
}

function producedCallsCheck(toolCalls: ToolCall[]): EvaluationCheck {
  return check("produced-calls", PRODUCED_CALLS, true, `${toolCalls.length} call(s)`);
}

function editToolCalls(toolCalls: ToolCall[]): ToolCall[] {
  return toolCalls.filter((tc) => tc.name === "edit");
}

function searchArgs(calls: ToolCall[]): string[] {
  return calls
    .map((tc) => tc.arguments.search)
    .filter((s): s is string => typeof s === "string" && s.length > 0);
}

/** Appends per-search resolution lines and the two document-match checks. */
function pushSearchMatchChecks(
  checks: EvaluationCheck[],
  evidence: string[],
  assessments: BlockAssessment[],
  document: string
): void {
  for (const [i, a] of assessments.entries()) {
    evidence.push(describeAssessment(a, i, document, "Search"));
  }

  const dead = assessments.filter((a) => !a.applies);
  checks.push(
    check(
      "search-matches",
      "Every search text matches the document",
      dead.length === 0,
      dead.length === 0
        ? `${assessments.length}/${assessments.length} searches resolve`
        : `${dead.length} of ${assessments.length} search(es) would fail to apply, see evidence for the closest-paragraph diagnosis`
    )
  );

  const fuzzy = assessments.filter((a) => a.applies && !a.exact);
  checks.push(
    check(
      "exact-match",
      "Search text matched the document exactly",
      fuzzy.length === 0,
      fuzzy.length === 0
        ? undefined
        : `${fuzzy.length} search(es) only matched via fuzzy matching, works, but the model is not quoting the document precisely`,
      false
    )
  );
}

// =========================================================================
// Evaluators
// =========================================================================

/**
 * Test: "Basic tool call"
 * Model should produce an edit with valid args whose search text
 * matches the document and lands on the requested phrase.
 */
export function evaluateBasicToolCall(
  response: string,
  testCase: BenchmarkTestCase,
  toolCalls?: ToolCall[] | null
): BenchmarkResult {
  if (!toolCalls || toolCalls.length === 0) return noToolCallsResult(response);

  const evidence = toolCalls.map(formatToolCall);
  const checks: EvaluationCheck[] = [producedCallsCheck(toolCalls)];

  const edits = editToolCalls(toolCalls);
  checks.push(
    check(
      "used-edit",
      "Used edit",
      edits.length > 0,
      edits.length > 0 ? undefined : `used ${toolCalls.map((tc) => tc.name).join(", ")} instead`
    )
  );
  if (edits.length === 0) return buildResultFromChecks(checks, evidence, "");

  const validArgs = edits.every(
    (tc) =>
      typeof tc.arguments.search === "string" &&
      tc.arguments.search.length > 0 &&
      typeof tc.arguments.replace === "string"
  );
  checks.push(
    check(
      "valid-args",
      "edit includes search and replace arguments",
      validArgs,
      validArgs ? undefined : "a call is missing the search or replace string argument"
    )
  );
  if (!validArgs) return buildResultFromChecks(checks, evidence, "");

  const targetLabel = "requested phrase ('twelve feet tall')";
  const assessments = assessSearchTexts(searchArgs(edits), testCase.document, [
    { label: targetLabel, text: "twelve feet tall" },
  ]);
  pushSearchMatchChecks(checks, evidence, assessments, testCase.document);

  const onTarget = assessments.some((a) => a.applies && a.overlaps.includes(targetLabel));
  checks.push(
    check(
      "edits-target",
      "Edit covers the requested phrase",
      onTarget,
      onTarget ? undefined : "no resolving search overlaps 'twelve feet tall'"
    )
  );

  return buildResultFromChecks(
    checks,
    evidence,
    "edit called with valid arguments that match the document and cover the requested phrase."
  );
}

/**
 * Test: "Correct tool for frontmatter"
 * Model should use update_frontmatter (not edit) with well-formed
 * operations that perform the requested changes.
 */
export function evaluateCorrectToolSelection(
  response: string,
  _testCase: BenchmarkTestCase,
  toolCalls?: ToolCall[] | null
): BenchmarkResult {
  if (!toolCalls || toolCalls.length === 0) return noToolCallsResult(response);

  const evidence = toolCalls.map(formatToolCall);
  const checks: EvaluationCheck[] = [producedCallsCheck(toolCalls)];

  const frontmatterCalls = toolCalls.filter((tc) => tc.name === "update_frontmatter");
  checks.push(
    check(
      "used-frontmatter-tool",
      "Used update_frontmatter",
      frontmatterCalls.length > 0,
      frontmatterCalls.length > 0
        ? undefined
        : `used ${toolCalls.map((tc) => tc.name).join(", ")} instead`
    )
  );

  const editCalls = editToolCalls(toolCalls);
  checks.push(
    check(
      "no-edit",
      "Did not fall back to edit for frontmatter",
      editCalls.length === 0,
      editCalls.length === 0
        ? undefined
        : "frontmatter must be changed via update_frontmatter, not text search/replace"
    )
  );
  if (frontmatterCalls.length === 0) return buildResultFromChecks(checks, evidence, "");

  interface Operation {
    key: string;
    action: string;
    value?: unknown;
  }
  const operations: Operation[] = frontmatterCalls.flatMap((tc) => {
    const ops = tc.arguments.operations;
    return Array.isArray(ops) ? (ops as Operation[]) : [];
  });

  const wellFormed =
    operations.length > 0 &&
    operations.every(
      (op) =>
        typeof op.key === "string" &&
        (op.action === "set" || op.action === "remove") &&
        (op.action !== "set" || op.value !== undefined)
    );
  checks.push(
    check(
      "ops-well-formed",
      "Operations are well-formed (key + set/remove action)",
      wellFormed,
      wellFormed
        ? `${operations.length} operation(s)`
        : "operations are missing, not an array, or have invalid key/action/value shapes"
    )
  );
  if (!wellFormed) return buildResultFromChecks(checks, evidence, "");

  const setsStatus = operations.some(
    (op) =>
      op.key === "status" && op.action === "set" && String(op.value).toLowerCase().includes("complete")
  );
  const removesTags = operations.some((op) => op.key === "tags" && op.action === "remove");
  const missing = [
    ...(setsStatus ? [] : ["set status to 'complete'"]),
    ...(removesTags ? [] : ["remove the tags field"]),
  ];
  checks.push(
    check(
      "requested-changes",
      "Performs both requested changes (status → complete, remove tags)",
      missing.length === 0,
      missing.length === 0 ? undefined : `missing: ${missing.join("; ")}`
    )
  );

  return buildResultFromChecks(
    checks,
    evidence,
    "update_frontmatter used with well-formed operations covering both requested changes."
  );
}

/**
 * Test: "Search text precision"
 * The edit call targeting the phrase must match the document and be
 * short, not a full section or the whole document.
 */
export function evaluateSearchPrecision(
  response: string,
  testCase: BenchmarkTestCase,
  toolCalls?: ToolCall[] | null
): BenchmarkResult {
  if (!toolCalls || toolCalls.length === 0) return noToolCallsResult(response);

  const evidence = toolCalls.map(formatToolCall);
  const checks: EvaluationCheck[] = [producedCallsCheck(toolCalls)];

  const edits = editToolCalls(toolCalls);
  const searches = searchArgs(edits);
  checks.push(
    check(
      "has-search",
      "edit called with search text",
      searches.length > 0,
      searches.length > 0
        ? undefined
        : edits.length === 0
          ? `used ${toolCalls.map((tc) => tc.name).join(", ")} instead`
          : "edit calls have no valid string search argument"
    )
  );
  if (searches.length === 0) return buildResultFromChecks(checks, evidence, "");

  const targetPhrase = "thatched rooftops";
  const maxSearchLength = 200;
  for (const search of searches) {
    evidence.push(`Search length: ${search.length} chars (max ${maxSearchLength})`);
  }

  // Any single precise, on-target, document-matching call passes; extra calls are ignored.
  const onTarget = searches.filter((s) => s.toLowerCase().includes(targetPhrase));
  checks.push(
    check(
      "targets-phrase",
      `A search contains "${targetPhrase}"`,
      onTarget.length > 0,
      onTarget.length > 0 ? undefined : "no search text contains the phrase the user asked to change"
    )
  );
  if (onTarget.length === 0) return buildResultFromChecks(checks, evidence, "");

  const assessments = assessSearchTexts(onTarget, testCase.document);
  const matching = onTarget.filter((_, i) => assessments[i].applies);
  checks.push(
    check(
      "search-matches",
      "The targeting search matches the document",
      matching.length > 0,
      matching.length > 0
        ? undefined
        : "the search contains the phrase but does not match the document text around it"
    )
  );

  const precise = matching.find((s) => s.length <= maxSearchLength);
  const minLength = matching.length > 0 ? Math.min(...matching.map((s) => s.length)) : 0;
  checks.push(
    check(
      "precise",
      `The targeting search is precise (≤${maxSearchLength} chars)`,
      precise !== undefined,
      precise !== undefined
        ? `${precise.length} chars`
        : matching.length > 0
          ? `shortest matching search is ${minLength} chars, the model included too much context`
          : "no matching search to measure"
    )
  );

  return buildResultFromChecks(
    checks,
    evidence,
    `Search text is precise and matches the document around "${targetPhrase}".`
  );
}

/**
 * Test: "Multiple distinct edits"
 * Three requested changes should yield three edit calls that each
 * match the document and cover all three replacements.
 */
export function evaluateMultipleEdits(
  response: string,
  testCase: BenchmarkTestCase,
  toolCalls?: ToolCall[] | null
): BenchmarkResult {
  if (!toolCalls || toolCalls.length === 0) return noToolCallsResult(response);

  const evidence = toolCalls.map(formatToolCall);
  const checks: EvaluationCheck[] = [producedCallsCheck(toolCalls)];

  const edits = editToolCalls(toolCalls);
  checks.push(
    check(
      "three-calls",
      "Made at least 3 edit calls (one per change)",
      edits.length >= 3,
      `${edits.length} edit call(s) for 3 requested changes`
    )
  );
  if (edits.length === 0) return buildResultFromChecks(checks, evidence, "");

  const assessments = assessSearchTexts(searchArgs(edits), testCase.document);
  pushSearchMatchChecks(checks, evidence, assessments, testCase.document);

  const replacements = edits
    .map((tc) => tc.arguments.replace)
    .filter((r): r is string => typeof r === "string")
    .map((r) => r.toLowerCase());
  const expected = ["fourteen", "cherry-red", "slate"];
  const missing = expected.filter((phrase) => !replacements.some((r) => r.includes(phrase)));
  checks.push(
    check(
      "covers-changes",
      "Covers all three requested replacements",
      missing.length === 0,
      missing.length === 0 ? undefined : `no replacement contains: ${missing.join(", ")}`
    )
  );

  return buildResultFromChecks(
    checks,
    evidence,
    "One edit per change, all matching the document and covering all three replacements."
  );
}

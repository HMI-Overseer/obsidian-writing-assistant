import type { ToolCall } from "../../tools/types";
import type { BenchmarkResult, BenchmarkTestCase } from "./types";

// =========================================================================
// Helpers
// =========================================================================

function formatToolCall(tc: ToolCall): string {
  const args = JSON.stringify(tc.arguments);
  const preview = args.length > 120 ? args.slice(0, 120) + "..." : args;
  return `${tc.name}(${preview})`;
}

function noToolCallsResult(response: string): BenchmarkResult {
  return {
    passed: false,
    reason: "Model did not produce any tool calls.",
    evidence: [response.slice(0, 200) || "(empty response)"],
  };
}

// =========================================================================
// Evaluators
// =========================================================================

/**
 * Test: "Basic tool call"
 * Model should produce at least one propose_edit with valid search/replace args.
 */
export function evaluateBasicToolCall(
  response: string,
  _testCase: BenchmarkTestCase,
  toolCalls?: ToolCall[] | null,
): BenchmarkResult {
  if (!toolCalls || toolCalls.length === 0) {
    return noToolCallsResult(response);
  }

  const evidence = toolCalls.map(formatToolCall);

  const applyEdits = toolCalls.filter((tc) => tc.name === "propose_edit");
  if (applyEdits.length === 0) {
    return {
      passed: false,
      reason: `Model used ${toolCalls.map((tc) => tc.name).join(", ")} but not propose_edit.`,
      evidence,
    };
  }

  const hasSearch = applyEdits.some((tc) =>
    typeof tc.arguments.search === "string" && tc.arguments.search.length > 0
  );
  const hasReplace = applyEdits.some((tc) =>
    typeof tc.arguments.replace === "string"
  );

  if (!hasSearch || !hasReplace) {
    return {
      passed: false,
      reason: "propose_edit tool call is missing search or replace arguments.",
      evidence,
    };
  }

  return {
    passed: true,
    reason: "Model correctly produced propose_edit tool call(s) with valid search and replace arguments.",
    evidence,
  };
}

/**
 * Test: "Correct tool for frontmatter"
 * Model should use update_frontmatter, not propose_edit, for frontmatter changes.
 */
export function evaluateCorrectToolSelection(
  response: string,
  _testCase: BenchmarkTestCase,
  toolCalls?: ToolCall[] | null,
): BenchmarkResult {
  if (!toolCalls || toolCalls.length === 0) {
    return noToolCallsResult(response);
  }

  const evidence = toolCalls.map(formatToolCall);

  const usesFrontmatterTool = toolCalls.some((tc) => tc.name === "update_frontmatter");
  const usesApplyEdit = toolCalls.some((tc) => tc.name === "propose_edit");

  if (usesFrontmatterTool && !usesApplyEdit) {
    return {
      passed: true,
      reason: "Model correctly used update_frontmatter for frontmatter changes.",
      evidence,
    };
  }

  if (usesFrontmatterTool && usesApplyEdit) {
    return {
      passed: false,
      reason: "Model used update_frontmatter but also used propose_edit for frontmatter (should use only update_frontmatter).",
      evidence,
    };
  }

  if (usesApplyEdit) {
    return {
      passed: false,
      reason: "Model used propose_edit instead of update_frontmatter for frontmatter changes.",
      evidence,
    };
  }

  return {
    passed: false,
    reason: `Model used ${toolCalls.map((tc) => tc.name).join(", ")} — expected update_frontmatter.`,
    evidence,
  };
}

/**
 * Test: "Search text precision"
 * propose_edit search should be short and contain the target phrase.
 */
export function evaluateSearchPrecision(
  response: string,
  _testCase: BenchmarkTestCase,
  toolCalls?: ToolCall[] | null,
): BenchmarkResult {
  if (!toolCalls || toolCalls.length === 0) {
    return noToolCallsResult(response);
  }

  const evidence = toolCalls.map(formatToolCall);
  const applyEdits = toolCalls.filter((tc) => tc.name === "propose_edit");

  if (applyEdits.length === 0) {
    return {
      passed: false,
      reason: "No propose_edit tool calls found.",
      evidence,
    };
  }

  const targetPhrase = "thatched rooftops";
  const maxSearchLength = 200;

  // Judge every propose_edit call: any single precise call targeting the phrase passes.
  const searches = applyEdits
    .map((tc) => tc.arguments.search)
    .filter((s): s is string => typeof s === "string");

  if (searches.length === 0) {
    return {
      passed: false,
      reason: "propose_edit calls did not have valid string search arguments.",
      evidence,
    };
  }

  for (const search of searches) {
    evidence.push(`Search length: ${search.length} chars (max ${maxSearchLength})`);
  }

  const onTarget = searches.filter((s) => s.toLowerCase().includes(targetPhrase));

  if (onTarget.length === 0) {
    return {
      passed: false,
      reason: `No propose_edit search text contains "${targetPhrase}".`,
      evidence,
    };
  }

  const precise = onTarget.find((s) => s.length <= maxSearchLength);
  if (precise) {
    return {
      passed: true,
      reason: `Search text is precise (${precise.length} chars) and contains the target phrase.`,
      evidence,
    };
  }

  return {
    passed: false,
    reason: `Search text targeting the phrase is too long (min ${Math.min(...onTarget.map((s) => s.length))} chars, max allowed ${maxSearchLength}). The model included too much context.`,
    evidence,
  };
}

/**
 * Test: "Multiple distinct edits"
 * Model should produce at least 3 edit tool calls for 3 requested changes.
 */
export function evaluateMultipleEdits(
  response: string,
  _testCase: BenchmarkTestCase,
  toolCalls?: ToolCall[] | null,
): BenchmarkResult {
  if (!toolCalls || toolCalls.length === 0) {
    return noToolCallsResult(response);
  }

  const evidence = toolCalls.map(formatToolCall);

  if (toolCalls.length >= 3) {
    return {
      passed: true,
      reason: `Model produced ${toolCalls.length} edit tool calls for 3 requested changes.`,
      evidence,
    };
  }

  return {
    passed: false,
    reason: `Model produced only ${toolCalls.length} edit tool call(s) — expected at least 3 for 3 distinct changes.`,
    evidence,
  };
}


import type { ToolCall } from "../../tools/types";
import { READ_ONLY_TOOL_NAMES } from "../../tools/editing/definition";
import type { BenchmarkResult, BenchmarkTestCase } from "./types";

// =========================================================================
// Helpers
// =========================================================================

function formatToolCall(tc: ToolCall): string {
  const args = JSON.stringify(tc.arguments);
  const preview = args.length > 120 ? args.slice(0, 120) + "..." : args;
  return `${tc.name}(${preview})`;
}

function getEditCalls(toolCalls: ToolCall[]): ToolCall[] {
  return toolCalls.filter((tc) => !READ_ONLY_TOOL_NAMES.has(tc.name));
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
 * Model should produce at least one apply_edit with valid search/replace args.
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
  const editCalls = getEditCalls(toolCalls);

  if (editCalls.length === 0) {
    return {
      passed: false,
      reason: "Model produced tool calls but none were edit tools (only read-only calls).",
      evidence,
    };
  }

  const applyEdits = editCalls.filter((tc) => tc.name === "apply_edit");
  if (applyEdits.length === 0) {
    return {
      passed: false,
      reason: `Model used edit tools (${editCalls.map((tc) => tc.name).join(", ")}) but not apply_edit.`,
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
      reason: "apply_edit tool call is missing search or replace arguments.",
      evidence,
    };
  }

  return {
    passed: true,
    reason: "Model correctly produced apply_edit tool call(s) with valid search and replace arguments.",
    evidence,
  };
}

/**
 * Test: "Inspect before edit"
 * First tool call should be get_document_outline or get_line_range.
 */
export function evaluateInspectBeforeEdit(
  response: string,
  _testCase: BenchmarkTestCase,
  toolCalls?: ToolCall[] | null,
): BenchmarkResult {
  if (!toolCalls || toolCalls.length === 0) {
    return noToolCallsResult(response);
  }

  const evidence = toolCalls.map(formatToolCall);
  const firstCall = toolCalls[0];

  if (READ_ONLY_TOOL_NAMES.has(firstCall.name)) {
    return {
      passed: true,
      reason: `Model correctly inspected first with ${firstCall.name} before making edits.`,
      evidence,
    };
  }

  return {
    passed: false,
    reason: `First tool call was ${firstCall.name} — expected get_document_outline or get_line_range.`,
    evidence,
  };
}

/**
 * Test: "Correct tool for frontmatter"
 * Model should use update_frontmatter, not apply_edit, for frontmatter changes.
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
  const editCalls = getEditCalls(toolCalls);

  const usesFrontmatterTool = editCalls.some((tc) => tc.name === "update_frontmatter");
  const usesApplyEdit = editCalls.some((tc) => tc.name === "apply_edit");

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
      reason: "Model used update_frontmatter but also used apply_edit for frontmatter (should use only update_frontmatter).",
      evidence,
    };
  }

  if (usesApplyEdit) {
    return {
      passed: false,
      reason: "Model used apply_edit instead of update_frontmatter for frontmatter changes.",
      evidence,
    };
  }

  return {
    passed: false,
    reason: `Model used ${editCalls.map((tc) => tc.name).join(", ")} — expected update_frontmatter.`,
    evidence,
  };
}

/**
 * Test: "Search text precision"
 * apply_edit search should be short and contain the target phrase.
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
  const applyEdits = toolCalls.filter((tc) => tc.name === "apply_edit");

  if (applyEdits.length === 0) {
    return {
      passed: false,
      reason: "No apply_edit tool calls found.",
      evidence,
    };
  }

  const targetPhrase = "thatched rooftops";
  const maxSearchLength = 200;

  for (const tc of applyEdits) {
    const search = tc.arguments.search;
    if (typeof search !== "string") continue;

    const containsTarget = search.toLowerCase().includes(targetPhrase);
    const isShort = search.length <= maxSearchLength;

    evidence.push(`Search length: ${search.length} chars (max ${maxSearchLength})`);

    if (containsTarget && isShort) {
      return {
        passed: true,
        reason: `Search text is precise (${search.length} chars) and contains the target phrase.`,
        evidence,
      };
    }

    if (!containsTarget) {
      return {
        passed: false,
        reason: `Search text does not contain "${targetPhrase}".`,
        evidence,
      };
    }

    return {
      passed: false,
      reason: `Search text is too long (${search.length} chars, max ${maxSearchLength}). The model included too much context.`,
      evidence,
    };
  }

  return {
    passed: false,
    reason: "apply_edit calls did not have valid string search arguments.",
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
  const editCalls = getEditCalls(toolCalls);

  if (editCalls.length >= 3) {
    return {
      passed: true,
      reason: `Model produced ${editCalls.length} edit tool calls for 3 requested changes.`,
      evidence,
    };
  }

  return {
    passed: false,
    reason: `Model produced only ${editCalls.length} edit tool call(s) — expected at least 3 for 3 distinct changes.`,
    evidence,
  };
}

/**
 * Test: "Core tools fallback"
 * With only core tools, model should still produce valid apply_edit calls.
 */
export function evaluateCoreToolsFallback(
  response: string,
  _testCase: BenchmarkTestCase,
  toolCalls?: ToolCall[] | null,
): BenchmarkResult {
  if (!toolCalls || toolCalls.length === 0) {
    return noToolCallsResult(response);
  }

  const evidence = toolCalls.map(formatToolCall);

  // Check no hallucinated tools (only apply_edit and insert_at_position are available)
  const validNames = new Set(["apply_edit", "insert_at_position"]);
  const hallucinatedCalls = toolCalls.filter((tc) => !validNames.has(tc.name));
  if (hallucinatedCalls.length > 0) {
    return {
      passed: false,
      reason: `Model hallucinated unavailable tools: ${hallucinatedCalls.map((tc) => tc.name).join(", ")}`,
      evidence,
    };
  }

  const applyEdits = toolCalls.filter((tc) => tc.name === "apply_edit");
  if (applyEdits.length === 0) {
    return {
      passed: false,
      reason: "No apply_edit calls found despite it being available in the core tool set.",
      evidence,
    };
  }

  const hasSearch = applyEdits.some((tc) =>
    typeof tc.arguments.search === "string" && tc.arguments.search.length > 0
  );
  if (!hasSearch) {
    return {
      passed: false,
      reason: "apply_edit call missing search argument.",
      evidence,
    };
  }

  return {
    passed: true,
    reason: "Model correctly used apply_edit from the core tool set with valid arguments.",
    evidence,
  };
}

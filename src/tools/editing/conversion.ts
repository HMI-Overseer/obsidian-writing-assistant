import type { ToolCall } from "../types";
import type { EditBlock } from "../../editing/editTypes";
import { validateProposeEdit, validateUpdateFrontmatter } from "./validation";
import type { FrontmatterOperation } from "./validation";

// ---------------------------------------------------------------------------
// Tool call → EditBlock conversion
// ---------------------------------------------------------------------------

/**
 * Normalize literal escape sequences that some LM Studio models emit
 * in tool call string arguments (e.g., literal `\n` instead of a newline).
 */
export function normalizeEscapes(value: unknown): string {
  if (typeof value !== "string") return "";
  // Only replace sequences that look like literal escape codes.
  // Actual newlines/tabs are untouched since they don't contain a backslash.
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\");
}

/**
 * Convert parsed tool calls into EditBlocks for the existing review pipeline.
 *
 * Each tool call's arguments are validated before conversion. Invalid tool
 * calls are skipped with a console.error — the model may have produced
 * malformed arguments that can't be converted to a meaningful EditBlock.
 *
 * Multiple `update_frontmatter` calls are merged into a single EditBlock
 * to prevent overlapping diffs when the model makes separate calls per
 * property instead of batching operations.
 */
export function toolCallsToEditBlocks(toolCalls: ToolCall[]): EditBlock[] {
  const blocks: EditBlock[] = [];
  const fmCalls: ToolCall[] = [];

  for (const tc of toolCalls) {
    if (tc.name === "update_frontmatter") {
      fmCalls.push(tc);
    } else {
      const block = convertToolCallToEditBlock(tc);
      if (block) blocks.push(block);
    }
  }

  // Merge all update_frontmatter calls into a single EditBlock.
  if (fmCalls.length > 0) {
    const merged = mergeUpdateFrontmatterCalls(fmCalls);
    if (merged) blocks.push(merged);
  }

  return blocks;
}

/**
 * Merge multiple update_frontmatter tool calls into a single EditBlock.
 * Models often make separate calls per property (e.g., one to remove "aliases",
 * another to remove "level") instead of batching. Merging prevents overlapping
 * diffs on the same frontmatter block.
 *
 * Later operations for the same key win (last-write-wins).
 */
function mergeUpdateFrontmatterCalls(calls: ToolCall[]): EditBlock | null {
  const allOperations: FrontmatterOperation[] = [];

  for (const tc of calls) {
    const v = validateUpdateFrontmatter(tc.arguments);
    if (!v.ok) {
      console.error(`[tool] Skipping update_frontmatter (${tc.id}): ${v.error}`);
      continue;
    }
    allOperations.push(...v.args.operations);
  }

  if (allOperations.length === 0) return null;

  // Deduplicate: last operation per key wins.
  const byKey = new Map<string, FrontmatterOperation>();
  for (const op of allOperations) {
    byKey.set(op.key, op);
  }
  const dedupedOperations = [...byKey.values()];

  // Use the first call's ID as the block ID.
  return {
    id: calls[0].id,
    searchText: "",
    replaceText: "",
    rawBlock: `[tool_call:${calls[0].id}]`,
    toolName: "update_frontmatter" as const,
    toolArgs: { operations: dedupedOperations },
  };
}

function convertToolCallToEditBlock(tc: ToolCall): EditBlock | null {
  switch (tc.name) {
    case "propose_edit": {
      const v = validateProposeEdit(tc.arguments);
      if (!v.ok) {
        console.error(`[tool] Skipping propose_edit (${tc.id}): ${v.error}`);
        return null;
      }
      return {
        id: tc.id,
        searchText: normalizeEscapes(v.args.search),
        replaceText: normalizeEscapes(v.args.replace),
        rawBlock: `[tool_call:${tc.id}]`,
      };
    }
    case "update_frontmatter": {
      const v = validateUpdateFrontmatter(tc.arguments);
      if (!v.ok) {
        console.error(`[tool] Skipping update_frontmatter (${tc.id}): ${v.error}`);
        return null;
      }
      return {
        id: tc.id,
        searchText: "", // Resolved later via current frontmatter extraction
        replaceText: "", // Resolved later via applying operations
        rawBlock: `[tool_call:${tc.id}]`,
        toolName: "update_frontmatter" as const,
        toolArgs: { operations: v.args.operations },
      };
    }
    default:
      // Unknown write tool — attempt generic search/replace extraction.
      return {
        id: tc.id,
        searchText: normalizeEscapes(tc.arguments.search),
        replaceText: normalizeEscapes(tc.arguments.replace),
        rawBlock: `[tool_call:${tc.id}]`,
      };
  }
}

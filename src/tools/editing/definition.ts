import type { CanonicalToolDefinition, ToolCall } from "../types";
import type { EditBlock } from "../../editing/editTypes";

export const APPLY_EDIT_TOOL: CanonicalToolDefinition = {
  name: "apply_edit",
  description:
    "Propose a targeted edit to the document. Specify the SHORT, exact text to find (search) " +
    "and ONLY the replacement for that region. Include 2-3 surrounding lines for unambiguous matching. " +
    "Never include the entire document or large sections. For deletions, provide an empty replace string.",
  parameters: {
    type: "object",
    properties: {
      search: {
        type: "string",
        description:
          "The exact text to find in the document. Keep it short — only the passage being changed " +
          "plus 2-3 surrounding lines for context. Never the full document.",
      },
      replace: {
        type: "string",
        description: "The replacement for the matched search region only. Not the whole document. Empty string for deletions.",
      },
      explanation: {
        type: "string",
        description: "Brief explanation of what this edit does and why.",
      },
    },
    required: ["search", "replace"],
  },
};

/** Convert parsed tool calls into EditBlocks for the existing review pipeline. */
export function toolCallsToEditBlocks(toolCalls: ToolCall[]): EditBlock[] {
  return toolCalls
    .filter((tc) => tc.name === "apply_edit")
    .map((tc) => ({
      id: tc.id,
      searchText: tc.arguments.search as string,
      replaceText: tc.arguments.replace as string,
      rawBlock: `[tool_call:${tc.id}]`,
    }));
}

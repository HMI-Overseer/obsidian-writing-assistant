import type { CanonicalToolDefinition, ToolCall } from "../types";
import type { EditBlock } from "../../editing/editTypes";

// ---------------------------------------------------------------------------
// Read-only tools — model calls these, gets results back, continues
// ---------------------------------------------------------------------------

export const GET_DOCUMENT_OUTLINE_TOOL: CanonicalToolDefinition = {
  name: "get_document_outline",
  description:
    "Get the heading structure and section boundaries of the current document. " +
    "Returns heading text, level (1-6), and line numbers, plus frontmatter presence and total line count. " +
    "Use this to understand document structure before making edits.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
};

export const GET_LINE_RANGE_TOOL: CanonicalToolDefinition = {
  name: "get_line_range",
  description:
    "Read a specific range of lines from the current document. Line numbers are 1-indexed. " +
    "Use this to inspect a section before editing it.",
  parameters: {
    type: "object",
    properties: {
      start_line: {
        type: "number",
        description: "First line to read (1-indexed).",
      },
      end_line: {
        type: "number",
        description: "Last line to read (1-indexed, inclusive). Omit or use -1 for end of file.",
      },
    },
    required: ["start_line"],
  },
};

/** Names of tools whose results are returned to the model (not applied to the document). */
export const READ_ONLY_TOOL_NAMES = new Set(["get_document_outline", "get_line_range"]);

// ---------------------------------------------------------------------------
// Write tools — produce EditBlocks for the diff review pipeline
// ---------------------------------------------------------------------------

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

export const REPLACE_SECTION_TOOL: CanonicalToolDefinition = {
  name: "replace_section",
  description:
    "Replace the entire content of a heading section (from the heading line to the next heading " +
    "of equal or higher level, or end of file). The heading text must match exactly. " +
    "Use get_document_outline first to find the correct heading.",
  parameters: {
    type: "object",
    properties: {
      heading: {
        type: "string",
        description: "The exact heading text (without the # prefix) to identify the section.",
      },
      new_content: {
        type: "string",
        description: "New content for the section body (excluding the heading line itself, which is preserved).",
      },
      explanation: {
        type: "string",
        description: "Brief explanation of the change.",
      },
    },
    required: ["heading", "new_content"],
  },
};

export const INSERT_AT_POSITION_TOOL: CanonicalToolDefinition = {
  name: "insert_at_position",
  description:
    "Insert text at a specific location. Use after_heading to insert below a heading, " +
    "or line_number to insert after a specific line (0 = beginning of file, -1 = end of file). " +
    "Provide exactly one of after_heading or line_number.",
  parameters: {
    type: "object",
    properties: {
      after_heading: {
        type: "string",
        description: "Insert after this heading (below the heading line). Mutually exclusive with line_number.",
      },
      line_number: {
        type: "number",
        description: "Insert after this line number (1-indexed, 0 = top of file, -1 = bottom). Mutually exclusive with after_heading.",
      },
      text: {
        type: "string",
        description: "The text to insert.",
      },
      explanation: {
        type: "string",
        description: "Brief explanation.",
      },
    },
    required: ["text"],
  },
};

export const UPDATE_FRONTMATTER_TOOL: CanonicalToolDefinition = {
  name: "update_frontmatter",
  description:
    "Add, update, or remove YAML frontmatter properties. Each operation specifies a key and an action. " +
    "If the document has no frontmatter, a new block will be created.",
  parameters: {
    type: "object",
    properties: {
      operations: {
        type: "array",
        description: "List of frontmatter changes to apply.",
        items: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "The frontmatter property name.",
            },
            value: {
              type: "string",
              description: "New value for the property. Required when action is 'set'.",
            },
            action: {
              type: "string",
              enum: ["set", "remove"],
              description: "Whether to set or remove the property.",
            },
          },
          required: ["key", "action"],
        },
      },
      explanation: {
        type: "string",
        description: "Brief explanation of the change.",
      },
    },
    required: ["operations"],
  },
};

/** All edit-mode tools, in the order they should appear in the API request. */
export const ALL_EDIT_TOOLS: CanonicalToolDefinition[] = [
  GET_DOCUMENT_OUTLINE_TOOL,
  GET_LINE_RANGE_TOOL,
  APPLY_EDIT_TOOL,
  REPLACE_SECTION_TOOL,
  INSERT_AT_POSITION_TOOL,
  UPDATE_FRONTMATTER_TOOL,
];

/**
 * Core tools for local models with limited tool-calling capacity.
 * Smaller models struggle with many tool schemas — keep it to the essentials.
 */
export const CORE_EDIT_TOOLS: CanonicalToolDefinition[] = [
  APPLY_EDIT_TOOL,
  INSERT_AT_POSITION_TOOL,
];

// ---------------------------------------------------------------------------
// Tool call → EditBlock conversion
// ---------------------------------------------------------------------------

/**
 * Normalize literal escape sequences that some LM Studio models emit
 * in tool call string arguments (e.g., literal `\n` instead of a newline).
 */
function normalizeEscapes(value: unknown): string {
  if (typeof value !== "string") return "";
  // Only replace sequences that look like literal escape codes.
  // Actual newlines/tabs are untouched since they don't contain a backslash.
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\");
}

/** Convert parsed tool calls into EditBlocks for the existing review pipeline. */
export function toolCallsToEditBlocks(toolCalls: ToolCall[]): EditBlock[] {
  const writeCalls = toolCalls.filter(
    (tc) => !READ_ONLY_TOOL_NAMES.has(tc.name),
  );

  return writeCalls.map((tc) => {
    switch (tc.name) {
      case "apply_edit":
        return {
          id: tc.id,
          searchText: normalizeEscapes(tc.arguments.search),
          replaceText: normalizeEscapes(tc.arguments.replace),
          rawBlock: `[tool_call:${tc.id}]`,
        };
      case "replace_section":
        return {
          id: tc.id,
          searchText: "", // Resolved later via MetadataCache in handlers
          replaceText: normalizeEscapes(tc.arguments.new_content),
          rawBlock: `[tool_call:${tc.id}]`,
          toolName: "replace_section" as const,
          toolArgs: { heading: normalizeEscapes(tc.arguments.heading) },
        };
      case "insert_at_position":
        return {
          id: tc.id,
          searchText: "", // Resolved later via heading/line lookup in handlers
          replaceText: normalizeEscapes(tc.arguments.text),
          rawBlock: `[tool_call:${tc.id}]`,
          toolName: "insert_at_position" as const,
          toolArgs: {
            after_heading: tc.arguments.after_heading
              ? normalizeEscapes(tc.arguments.after_heading) : undefined,
            line_number: tc.arguments.line_number as number | undefined,
          },
        };
      case "update_frontmatter":
        return {
          id: tc.id,
          searchText: "", // Resolved later via current frontmatter extraction
          replaceText: "", // Resolved later via applying operations
          rawBlock: `[tool_call:${tc.id}]`,
          toolName: "update_frontmatter" as const,
          toolArgs: {
            operations: tc.arguments.operations as Array<{ key: string; value?: string; action: string }>,
          },
        };
      default:
        return {
          id: tc.id,
          searchText: normalizeEscapes(tc.arguments.search),
          replaceText: normalizeEscapes(tc.arguments.replace),
          rawBlock: `[tool_call:${tc.id}]`,
        };
    }
  });
}

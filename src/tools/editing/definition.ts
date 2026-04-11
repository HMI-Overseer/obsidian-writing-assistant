import type { CanonicalToolDefinition } from "../types";

// ---------------------------------------------------------------------------
// Write tools — produce EditBlocks for the diff review pipeline
// ---------------------------------------------------------------------------

export const PROPOSE_EDIT_TOOL: CanonicalToolDefinition = {
  name: "propose_edit",
  description:
    "Propose a targeted search-and-replace edit to the document. " +
    "The edit is shown to the user for review before being applied. " +
    "Use one call per distinct change — multiple changes require multiple propose_edit calls.",
  strategyHint:
    "targeted search/replace for prose changes. Requires exact text from the document — " +
    "use read_file first if the document content is not already in context.",
  errorGuidance:
    "If the search text was not found, re-read the document with read_file and match the exact text including whitespace.",
  parameters: {
    type: "object",
    properties: {
      search: {
        type: "string",
        description:
          "The exact text to find in the document. Must match character-for-character " +
          "including whitespace and indentation. " +
          "Keep it SHORT — include only the passage being changed plus 2–3 surrounding lines " +
          "for unambiguous matching. Never include large sections or the full document.",
      },
      replace: {
        type: "string",
        description:
          "The replacement text for the matched search region only. " +
          "Must contain ONLY the new content for that region — not the rest of the document. " +
          "Use an empty string to delete the matched text.",
      },
      explanation: {
        type: "string",
        description: "Brief explanation of what this edit does and why.",
      },
    },
    required: ["search", "replace"],
  },
};

export const UPDATE_FRONTMATTER_TOOL: CanonicalToolDefinition = {
  name: "update_frontmatter",
  description:
    "Add, update, or remove YAML frontmatter properties. Put ALL frontmatter changes into a single call " +
    "with multiple operations — do not make separate calls per property. " +
    "To keep only specific properties, remove all the others by name. " +
    "If the document has no frontmatter, a new block will be created.",
  strategyHint:
    "add, update, or remove YAML frontmatter properties. Batch all changes into a single call.",
  errorGuidance:
    "If operations are invalid, check the key names and action values (must be 'set' or 'remove').",
  parameters: {
    type: "object",
    properties: {
      operations: {
        type: "array",
        description: "List of frontmatter changes to apply. Include ALL changes in one call.",
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
  PROPOSE_EDIT_TOOL,
  UPDATE_FRONTMATTER_TOOL,
];

/** Set of edit tool names for fast membership checks in the tool loop. */
export const EDIT_TOOL_NAMES = new Set(ALL_EDIT_TOOLS.map((t) => t.name));

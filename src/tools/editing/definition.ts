import type { CanonicalToolDefinition } from "../types";

// ---------------------------------------------------------------------------
// Write tools, produce EditBlocks for the diff review pipeline
// ---------------------------------------------------------------------------

export const PROPOSE_EDIT_TOOL: CanonicalToolDefinition = {
  name: "propose_edit",
  description:
    "Propose a targeted search-and-replace edit to a note. " +
    "Always pass `path`, the vault-relative path of the note to change (the one shown as the " +
    "document to edit, or the path you read with read_file). " +
    "The edit is shown to the user for review before being applied. " +
    "The note must already contain the search text, for an empty or brand-new note, " +
    "use write_file to set its initial content instead. " +
    "Use one call per distinct change; a single turn edits one file, edit other files in later turns.",
  strategyHint:
    "targeted search/replace for prose changes in a specific note (`path`). Requires exact text " +
    "from that note, use read_file first if its content is not already in context. " +
    "For an empty document there is nothing to match; use write_file instead.",
  errorGuidance:
    "If `path` is missing or the file is not found, supply the correct vault-relative path. " +
    "If the search text was not found because the document is empty, switch to write_file to set " +
    "its initial content. If the search text matched more than one place, add the surrounding lines " +
    "so it identifies exactly one passage. Otherwise re-read the document with read_file and match " +
    "the exact text, including whitespace and dropping read_file's line-number prefix.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Vault-relative path of the note to edit (e.g. \"Lore/The Fold.md\"). " +
          "Use the path of the document under edit or the file you read with read_file.",
      },
      search: {
        type: "string",
        description:
          "The exact text to find in the document. Match it character-for-character, " +
          "including whitespace and indentation. " +
          "If you copied the passage from read_file, drop the leading line-number prefix " +
          "(the right-aligned number and the tab after it); match only the line text itself. " +
          "Keep it SHORT, include only the passage being changed plus 2–3 surrounding lines " +
          "for unambiguous matching. Never include large sections or the full document.",
      },
      replace: {
        type: "string",
        description:
          "The replacement text for the matched search region only. " +
          "Must contain ONLY the new content for that region, not the rest of the document. " +
          "Use an empty string to delete the matched text.",
      },
      explanation: {
        type: "string",
        description: "Brief explanation of what this edit does and why.",
      },
    },
    required: ["path", "search", "replace"],
  },
};

export const UPDATE_FRONTMATTER_TOOL: CanonicalToolDefinition = {
  name: "update_frontmatter",
  description:
    "Add, update, or remove YAML frontmatter properties of a note. Always pass `path`, the " +
    "vault-relative path of the note to change. Put ALL changes into one call. " +
    "Each operation must use action 'set' or 'remove'. Skip properties you want to leave as-is. " +
    "If the document has no frontmatter, a new block will be created.",
  strategyHint:
    "add, update, or remove YAML frontmatter properties of a specific note (`path`). Batch all changes into a single call.",
  errorGuidance:
    "If `path` is missing or the file is not found, supply the correct vault-relative path. " +
    "If operations are invalid, check the key names and action values (must be 'set' or 'remove').",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Vault-relative path of the note whose frontmatter to edit (e.g. \"Lore/The Fold.md\").",
      },
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
    required: ["path", "operations"],
  },
};

/** All edit-mode tools, in the order they should appear in the API request. */
export const ALL_EDIT_TOOLS: CanonicalToolDefinition[] = [
  PROPOSE_EDIT_TOOL,
  UPDATE_FRONTMATTER_TOOL,
];

/** Set of edit tool names for fast membership checks in the tool loop. */
export const EDIT_TOOL_NAMES = new Set(ALL_EDIT_TOOLS.map((t) => t.name));

import type { CanonicalToolDefinition } from "../types";

export const SEARCH_VAULT_TOOL: CanonicalToolDefinition = {
  name: "semantic_search",
  description:
    "Search the vault index for notes relevant to a query. Returns the most relevant chunks " +
    "with their source file, heading path, similarity score, and content. " +
    "Use this when you need information from the vault that wasn't in the initial context, " +
    "or to follow up on references found in previous results.",
  strategyHint: "find notes by meaning when you know what you need but not where it lives",
  errorGuidance: "Retry with a rephrased or more specific query. Never repeat the same query exactly.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "The search query. Be specific — include character names, concept names, or " +
          "event descriptions rather than generic phrases.",
      },
      top_k: {
        type: "number",
        description:
          "Maximum number of results to return. Defaults to the configured retrieval limit. " +
          "Use a higher value for broad survey queries.",
      },
    },
    required: ["query"],
  },
};

export const READ_NOTE_TOOL: CanonicalToolDefinition = {
  name: "read_note",
  description:
    "Read the full content of a specific vault note by its file path. " +
    "Use this when you already know which note you need (e.g., from a wikilink or search result) " +
    "and want the complete text rather than matched chunks.",
  strategyHint: "read the full content of a specific note once you know its path",
  errorGuidance: "If the note was not found, call list_folder first to locate the correct path.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Vault-relative file path (e.g., 'Characters/Will.md'). " +
          "Paths are case-sensitive on most systems.",
      },
    },
    required: ["path"],
  },
};

export const LIST_FOLDER_TOOL: CanonicalToolDefinition = {
  name: "list_folder",
  description:
    "List all notes and subfolders within a vault folder. " +
    "Use this to discover what notes exist before reading or searching them. " +
    "Start here when asked to explore or survey the vault — it gives you a map before you dive in. " +
    "Use depth > 1 to get the full subtree in a single call instead of listing each subfolder separately. " +
    "Omit path to list the vault root.",
  strategyHint: "discover what notes and folders exist — use depth 2-3 to get a full subtree in one call",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Vault-relative folder path (e.g., 'Characters' or 'Scenes/Act 1'). " +
          "Omit to list the vault root.",
      },
      depth: {
        type: "number",
        description:
          "How many levels deep to recurse. 1 = immediate children only (default). " +
          "2 or 3 = include subfolders and their contents. Maximum 3.",
      },
    },
    required: [],
  },
};

export const GET_BACKLINKS_TOOL: CanonicalToolDefinition = {
  name: "get_backlinks",
  description:
    "Find all notes that link to a given note via wikilinks or markdown links. " +
    "Use this to answer 'which scenes feature this character?' or 'what references this concept?'. " +
    "More reliable than semantic search for explicit wikilink connections — " +
    "a scene may link [[Character Name]] without ever spelling out the name in prose.",
  strategyHint: "find every note that links to a given note (reliable for explicit wikilink connections)",
  errorGuidance: "If the note was not found, call list_folder to find the correct path.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Vault-relative path of the target note (e.g., 'Characters/Will.md').",
      },
    },
    required: ["path"],
  },
};

export const FIND_NOTES_BY_TAG_TOOL: CanonicalToolDefinition = {
  name: "find_notes_by_tag",
  description:
    "Return all notes that carry a specific tag (frontmatter or inline). " +
    "Use this to enumerate notes by type or category " +
    "(e.g., '#character', '#location', '#antagonist'). " +
    "Call list_folder first if you are not sure which tags exist.",
  strategyHint: "enumerate notes by type or category (e.g. #character, #location)",
  errorGuidance: "If no notes found, the result will suggest similar tags — try one of those.",
  parameters: {
    type: "object",
    properties: {
      tag: {
        type: "string",
        description:
          "Tag to search for, with or without # prefix (e.g., 'character' or '#character').",
      },
    },
    required: ["tag"],
  },
};

export const GET_FRONTMATTER_TOOL: CanonicalToolDefinition = {
  name: "get_frontmatter",
  description:
    "Read the structured YAML metadata (frontmatter) from one or more notes without loading " +
    "their full prose content. Use this to compare attributes across several notes efficiently " +
    "(e.g., species, affiliation, status across all characters). " +
    "Accepts multiple paths in one call to avoid multiple round trips.",
  strategyHint: "compare structured attributes across several notes without reading full content",
  parameters: {
    type: "object",
    properties: {
      paths: {
        type: "array",
        description: "One or more vault-relative note paths.",
        items: { type: "string" },
      },
    },
    required: ["paths"],
  },
};

/**
 * Core vault tools — suitable for all modes and local models.
 * Covers the three fundamental operations: meaning-based search, direct note
 * reading, and structural discovery.
 */
export const CORE_VAULT_TOOLS: CanonicalToolDefinition[] = [
  LIST_FOLDER_TOOL,
  READ_NOTE_TOOL,
  SEARCH_VAULT_TOOL,
];

/**
 * Full vault tool suite — for chat and plan modes with cloud providers.
 * Adds Obsidian-native tools (backlinks, tags, frontmatter) on top of the
 * core set for richer exploration.
 */
export const ALL_VAULT_TOOLS: CanonicalToolDefinition[] = [
  LIST_FOLDER_TOOL,
  FIND_NOTES_BY_TAG_TOOL,
  GET_BACKLINKS_TOOL,
  GET_FRONTMATTER_TOOL,
  READ_NOTE_TOOL,
  SEARCH_VAULT_TOOL,
];

/** Names of all vault tools — all are read-only (results returned to the model). */
export const VAULT_TOOL_NAMES = new Set([
  "semantic_search",
  "read_note",
  "list_folder",
  "get_backlinks",
  "find_notes_by_tag",
  "get_frontmatter",
]);

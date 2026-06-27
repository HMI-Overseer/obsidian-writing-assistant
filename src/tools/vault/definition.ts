import type { CanonicalToolDefinition } from "../types";
import type { RagAvailability } from "../../rag/ragService";

export const READ_FILE_TOOL: CanonicalToolDefinition = {
  name: "read_file",
  description:
    "Read the full content of a specific vault note by its file path. " +
    "Use this when you already know which note you need (e.g., from a wikilink or search result) " +
    "and want the complete text rather than matched chunks. " +
    "Lines are returned with cat -n style line numbers (a right-aligned number, a tab, then the " +
    "line) for reference only; the text after the tab is verbatim. When quoting a line back to an " +
    "edit tool, use only that text and drop the line-number prefix.",
  strategyHint: "read the full content of a specific note once you know its path (output is line-numbered)",
  errorGuidance: "If the note was not found, call list_directory first to locate the correct path.",
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

export const LIST_DIRECTORY_TOOL: CanonicalToolDefinition = {
  name: "list_directory",
  description:
    "List the immediate contents of a vault folder with [FILE] and [DIR] prefixes. " +
    "Use this to discover what notes and subfolders exist at a specific level. " +
    "Omit path to list the vault root.",
  strategyHint: "discover immediate children of a folder, use directory_tree for a full subtree",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Vault-relative folder path (e.g., 'Characters' or 'Scenes/Act 1'). " +
          "Omit to list the vault root.",
      },
    },
    required: [],
  },
};

export const DIRECTORY_TREE_TOOL: CanonicalToolDefinition = {
  name: "directory_tree",
  description:
    "Get a recursive JSON tree of all notes and subfolders within a vault folder. " +
    "Use this when you need the full structure of a folder and its descendants in one call. " +
    "Omit path to get the entire vault tree.",
  strategyHint: "get the full recursive structure of a folder or the whole vault in one call",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Vault-relative folder path (e.g., 'Characters'). " +
          "Omit to get the entire vault tree.",
      },
    },
    required: [],
  },
};

export const SEARCH_FILES_TOOL: CanonicalToolDefinition = {
  name: "search_files",
  description:
    "Recursively search for notes whose filenames match a glob pattern. " +
    "Use this when you know part of a note's name but not its exact path. " +
    "Supports * (any characters) and ? (single character) wildcards. " +
    "Omit path to search the entire vault.",
  strategyHint: "find notes by filename pattern when you know the name but not the path",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Vault-relative folder to search within. Omit to search the entire vault.",
      },
      pattern: {
        type: "string",
        description:
          "Glob pattern matched against file names (e.g., 'Will*', '*chapter*', '*.md'). " +
          "Case-insensitive.",
      },
      excludePatterns: {
        type: "array",
        description: "Optional list of glob patterns to exclude from results.",
        items: { type: "string" },
      },
    },
    required: ["pattern"],
  },
};

export const SEARCH_CONTENT_TOOL: CanonicalToolDefinition = {
  name: "search_content",
  description:
    "Search the bodies of vault notes for an exact string (or, optionally, a regex) and return " +
    "the matching file path, line number, and a short snippet per hit, not whole notes. " +
    "Use this to locate a literal token you can name precisely: a heading, a citation key, a " +
    "person's name, a TODO marker, a phrase to fix. This is lexical search, for meaning-based " +
    "retrieval ('what's about X') use semantic_search instead; for the exact string X, use this. " +
    "Unlike semantic_search it needs no index, so it works even when the index is unavailable.",
  strategyHint:
    "find where an exact string or pattern appears in note bodies (lexical, pair with semantic_search for meaning)",
  errorGuidance:
    "If the regex is invalid, fix the pattern or set regex to false for a literal substring search.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "The literal text to find (or a regular expression when regex is true). " +
          "Matched against note bodies line by line.",
      },
      path: {
        type: "string",
        description: "Vault-relative folder to search within. Omit to search the entire vault.",
      },
      regex: {
        type: "boolean",
        description:
          "Treat query as a JavaScript regular expression rather than a literal substring. " +
          "Defaults to false. Keep patterns simple, a malformed pattern returns an error.",
      },
      caseSensitive: {
        type: "boolean",
        description: "Match case exactly. Defaults to false (case-insensitive).",
      },
      contextLines: {
        type: "number",
        description:
          "Lines of surrounding context to show before and after each match (like grep -C), 0–5. " +
          "Defaults to 0. In prose a line is usually a whole paragraph, so 1–2 gives the " +
          "sentence before/after, set this instead of following a hit with read_file.",
      },
      excludePatterns: {
        type: "array",
        description: "Optional list of filename glob patterns to exclude from the scan.",
        items: { type: "string" },
      },
    },
    required: ["query"],
  },
};

export const SEARCH_VAULT_TOOL: CanonicalToolDefinition = {
  name: "semantic_search",
  description:
    "Search the vault index for notes relevant to a query. Returns the most relevant chunks " +
    "with their source file, heading path, similarity score, and content. " +
    "Use this when you need information from the vault that wasn't in the initial context, " +
    "or to follow up on references found in previous results.",
  strategyHint: "find notes by meaning when you know what you need but not where it lives",
  errorGuidance:
    "If the result says semantic search could not run (no embedding backend, no index, or an " +
    "unreachable model), do NOT rephrase or retry, follow that result's instructions, which means " +
    "switching to search_content for an exact-string lookup. Only when it actually ran and returned " +
    "no results should you retry once with a more specific query; never repeat the same query exactly.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "The search query. Be specific, include character names, concept names, or " +
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

export const GET_BACKLINKS_TOOL: CanonicalToolDefinition = {
  name: "get_backlinks",
  description:
    "Find all notes that link to a given note via wikilinks or markdown links. " +
    "Use this to answer 'which scenes feature this character?' or 'what references this concept?'. " +
    "More reliable than semantic search for explicit wikilink connections, " +
    "a scene may link [[Character Name]] without ever spelling out the name in prose.",
  strategyHint: "find every note that links to a given note (reliable for explicit wikilink connections)",
  errorGuidance: "If the note was not found, call list_directory to find the correct path.",
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
    "Call list_directory first if you are not sure which tags exist.",
  strategyHint: "enumerate notes by type or category (e.g. #character, #location)",
  errorGuidance: "If no notes found, the result will suggest similar tags, try one of those.",
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
 * Core vault tools, suitable for all modes and local models.
 * Covers the fundamental operations: structural discovery, meaning-based and
 * lexical (exact-text) search, and direct note reading. search_content has no
 * embedding dependency, so it stays available as the content fallback even when
 * semantic_search is filtered out (cold RAG index).
 */
export const CORE_VAULT_TOOLS: CanonicalToolDefinition[] = [
  LIST_DIRECTORY_TOOL,
  SEARCH_VAULT_TOOL,
  SEARCH_CONTENT_TOOL,
  READ_FILE_TOOL,
];

/**
 * Full vault tool suite, for chat and plan modes with cloud providers.
 * Adds recursive tree, filename search, and Obsidian-native tools
 * (backlinks, tags, frontmatter) on top of the core set.
 */
export const ALL_VAULT_TOOLS: CanonicalToolDefinition[] = [
  LIST_DIRECTORY_TOOL,
  DIRECTORY_TREE_TOOL,
  SEARCH_FILES_TOOL,
  SEARCH_CONTENT_TOOL,
  FIND_NOTES_BY_TAG_TOOL,
  GET_BACKLINKS_TOOL,
  GET_FRONTMATTER_TOOL,
  READ_FILE_TOOL,
  SEARCH_VAULT_TOOL,
];

/** Names of all vault tools, all are read-only (results returned to the model). */
export const VAULT_TOOL_NAMES = new Set([
  "semantic_search",
  "search_content",
  "read_file",
  "list_directory",
  "directory_tree",
  "search_files",
  "get_backlinks",
  "find_notes_by_tag",
  "get_frontmatter",
]);

/**
 * The ways `semantic_search` can be unavailable. Extends the static
 * {@link RagAvailability} states (minus `ready`) with `unreachable`, a
 * configured, indexed backend that fails at *call* time (model stopped/unloaded,
 * endpoint down), which no synchronous check can see.
 */
export type SemanticSearchUnavailableReason =
  | Exclude<RagAvailability, "ready">
  | "unreachable";

/**
 * Model-facing message for each way `semantic_search` is unavailable, the contract
 * the model reasons from and relays to the user. Each names, in order: (1) the exact
 * condition that is true, (2) why it blocks semantic search, (3) what the user must do
 * to fix it (with the literal Settings path), and (4) what to do right now instead.
 * No hedging ("may", "might"): a failure to run is reported as a failure, never as an
 * empty vault. Kept here so the handler and any future UI surface read one source.
 * See docs/work/issues/semantic-search-silent-embedding-failure.md §6.
 */
export const SEMANTIC_SEARCH_UNAVAILABLE_MESSAGE: Record<
  SemanticSearchUnavailableReason,
  string
> = {
  "no-backend":
    'Semantic search did not run: no embedding model is configured, so this vault has no ' +
    "semantic index and one cannot be built. Semantic search needs an embedding model to turn " +
    "notes into vectors; without one it is permanently unavailable, not merely empty. To enable " +
    "it, add an embedding model under Settings → Embedding Model Profiles, then select it " +
    "under Settings → Retrieval (RAG). For now, use search_content to find an exact word or " +
    "phrase, and list_directory / read_file to navigate by structure.",
  "index-empty":
    "Semantic search did not run: an embedding model is configured, but the index has never been " +
    "built, so there is nothing to search. This does NOT mean the vault is empty. Build it once " +
    "with 'Build index' under Settings → Retrieval (RAG). Until that finishes, use " +
    "search_content to find an exact word or phrase.",
  unreachable:
    "Semantic search did not run: the embedding model is configured and an index exists, but the " +
    "embedding request failed, the model is unreachable (it may be stopped, unloaded, or the " +
    "endpoint is down). This is a failure to run, NOT an empty result, do not conclude the " +
    "vault lacks this content. Check that the embedding model is running and reachable to restore " +
    "semantic search. Right now, use search_content for an exact-string lookup.",
};

/**
 * Drop `semantic_search` from a tool list when the embedding backend cannot serve a
 * query. Shared by both advertising routes, the in-app tool list
 * ({@link ../../chat/finalization/prepareApiMessages}) and the Claude Code MCP bridge
 * ({@link ../../services/ClaudeCodeService}), so they cannot gate it differently and
 * drift apart, which is the defect that produced the silent-failure symptom.
 * See docs/work/issues/semantic-search-silent-embedding-failure.md §3-A/B, §4.
 */
export function filterSemanticSearchByAvailability(
  tools: CanonicalToolDefinition[],
  availability: RagAvailability,
): CanonicalToolDefinition[] {
  if (availability === "ready") return tools;
  return tools.filter((t) => t.name !== "semantic_search");
}

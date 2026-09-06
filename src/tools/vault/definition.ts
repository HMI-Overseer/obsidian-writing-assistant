import type { CanonicalToolDefinition } from "../types";
import type { RagAvailability } from "../../rag/ragService";

/**
 * The whole-note and single-section reads under one name (RFC-0015), dispatching on
 * whether `headingPath` is present. Its guidance is the union of the two predecessors',
 * organised by pathway per the RFC's additive rule: the section pathway keeps every
 * piece of its heading-ambiguity guidance, and only the wrong-sibling clause goes,
 * because the distinction is no longer the model's to make. Kept tight on purpose:
 * `read` is core, so this text sits in the cached prefix on every request (ADR-0009).
 */
export const READ_TOOL: CanonicalToolDefinition = {
  name: "read",
  description:
    "Read a vault note by its file path. With path alone, returns the whole note: the " +
    "complete text, not matched chunks. Add headingPath to read one section instead, the " +
    "heading plus everything beneath it down to the next heading of the same or higher " +
    "level, so a parent heading includes its subsections and a deeper headingPath narrows " +
    "further. Take the headingPath from get_outline, and for a long or heavily structured " +
    "note prefer outlining first and reading only the part you need. If a bare heading is " +
    "duplicated in the note, pass the full headingPath to disambiguate. Either way lines " +
    "come back with cat -n style line numbers (a right-aligned number, a tab, then the " +
    "line) for reference only, and a section carries the note's own numbers, so the two " +
    "agree. The text after the tab is verbatim; when quoting a line back to an edit tool, " +
    "use only that text and drop the line-number prefix.",
  strategyHint:
    "read a note once you know its path (output is line-numbered); for a long structured " +
    "note, prefer get_outline then read with that headingPath",
  errorGuidance:
    "If the note was not found, call list_directory first to locate the correct path. " +
    "If the heading was not found, call get_outline to see the note's exact heading paths. " +
    "If the heading is ambiguous, pass one of the full headingPaths listed in the error. " +
    "If the note has no headings, omit headingPath.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Vault-relative file path (e.g., 'Characters/Will.md'). " +
          "Paths are case-sensitive on most systems.",
      },
      headingPath: {
        type: "string",
        description:
          "Optional. The section's full breadcrumb as shown by get_outline, e.g. " +
          "\"Act I > Chapter 3 > The Duel\". A shorter trailing path narrows to that heading; " +
          "pass the full path when a bare heading is duplicated. Omit to read the whole note.",
      },
    },
    required: ["path"],
  },
};

export const GET_OUTLINE_TOOL: CanonicalToolDefinition = {
  name: "get_outline",
  description:
    "Get the heading structure of a single note without reading its prose. For each heading it " +
    "returns the depth, the full headingPath (e.g. \"Act I > Chapter 3 > The Duel\"), and an " +
    "approximate word and line count for that heading's section. Use this to survey a long or " +
    "structured note and decide which part to read, then pass a headingPath to read. " +
    "A note with no headings is reported as such (read it whole with read instead).",
  strategyHint:
    "survey the heading tree of a long note, then read the part you need by its headingPath " +
    "(cheaper than reading a whole manuscript)",
  errorGuidance: "If the note was not found, call list_directory or search_files to locate the correct path.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Vault-relative file path (e.g., 'Manuscript/Act I.md'). " +
          "Paths are case-sensitive on most systems.",
      },
    },
    required: ["path"],
  },
};

export const LIST_DIRECTORY_TOOL: CanonicalToolDefinition = {
  name: "list_directory",
  description:
    "List the contents of a vault folder as [FILE] and [DIR] lines, one full path per line, " +
    "sorted. Use this to discover what notes and subfolders exist. Omit path for the vault " +
    "root. One level by default; raise depth to take in a whole subtree in one call. " +
    "A very large listing is truncated and says so.",
  strategyHint:
    "discover what a folder holds, its immediate children by default, a subtree with depth",
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
          "How many folder levels to list. Defaults to 1, the folder's immediate children. " +
          "Higher values also list what its subfolders hold, down to the whole subtree.",
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
          "sentence before/after, set this instead of following a hit with read.",
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
      topK: {
        type: "number",
        description:
          "Maximum number of results to return, 1 to 20. Defaults to the configured " +
          "retrieval limit. Raise it for a broad survey, lower it when one strong hit is " +
          "enough; fewer may come back when the remaining matches are much weaker.",
      },
    },
    required: ["query"],
  },
};

/** The direction a `get_links` call may narrow to. Omitting it asks for both. */
export type LinkDirection = "incoming" | "outgoing";

/** Valid `direction` values, also the schema enum (single source of truth). */
export const LINK_DIRECTIONS: LinkDirection[] = ["incoming", "outgoing"];

export const GET_LINKS_TOOL: CanonicalToolDefinition = {
  name: "get_links",
  description:
    "Find the notes a given note is connected to by wikilinks or markdown links, in either " +
    "direction. Incoming links are the notes that link to it: use them to answer 'which " +
    "scenes feature this character?' or 'what references this concept?'. More reliable than " +
    "semantic search for explicit wikilink connections, a scene may link [[Character Name]] " +
    "without ever spelling out the name in prose. Outgoing links are the notes it links out " +
    "to: use them to follow what a scene draws on (the characters, locations, and lore it " +
    "mentions) without reading the whole note and parsing its [[wikilinks]] by hand. " +
    "Omit direction to get both, each under its own heading. " +
    "Returns resolved links only (links whose target note exists).",
  strategyHint:
    "find a note's link connections, both directions at once or one of them with direction",
  errorGuidance: "If the note was not found, call list_directory or search_files to find the correct path.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Vault-relative path of the note (e.g., 'Characters/Will.md').",
      },
      direction: {
        type: "string",
        enum: LINK_DIRECTIONS,
        description:
          "Narrow to one direction: \"incoming\" for the notes that link to this one, " +
          "\"outgoing\" for the notes it links to. Omit for both.",
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
  READ_TOOL,
];

/**
 * Full vault tool suite for cloud providers.
 * Adds filename search, Obsidian-native tools (links, tags, frontmatter), and
 * get_outline, the structure survey that makes a headingPath obtainable, on top of the
 * core set. get_outline is cloud-only for now; CORE (local) inclusion is deferred to
 * the tool benchmark rather than assumed (ADR-0009). Section reading is no longer a
 * tool of its own: it is `read` with a headingPath (RFC-0015), so it travels with the
 * core wherever `read` goes.
 */
export const ALL_VAULT_TOOLS: CanonicalToolDefinition[] = [
  LIST_DIRECTORY_TOOL,
  SEARCH_FILES_TOOL,
  SEARCH_CONTENT_TOOL,
  FIND_NOTES_BY_TAG_TOOL,
  GET_LINKS_TOOL,
  GET_FRONTMATTER_TOOL,
  READ_TOOL,
  GET_OUTLINE_TOOL,
  SEARCH_VAULT_TOOL,
];

/**
 * Names of all vault tools, all are read-only (results returned to the model).
 * Derived from {@link ALL_VAULT_TOOLS}, like the edit / vault-op / memory family sets,
 * so it cannot fall behind the definitions it stands for. It classifies a refused call
 * as read-only ({@link ../toolSurface.toolNotAllowedFailure}) and guards the read
 * dispatch ({@link ./handlers.executeVaultTool}), so a stale entry there is a
 * mis-classification, not a cosmetic drift.
 */
export const VAULT_TOOL_NAMES = new Set(ALL_VAULT_TOOLS.map((tool) => tool.name));

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
 * See ADR-0022.
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
    "phrase, and list_directory / read to navigate by structure.",
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
 * See ADR-0022.
 */
export function filterSemanticSearchByAvailability(
  tools: CanonicalToolDefinition[],
  availability: RagAvailability,
): CanonicalToolDefinition[] {
  if (availability === "ready") return tools;
  return tools.filter((t) => t.name !== "semantic_search");
}

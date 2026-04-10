import type { CanonicalToolDefinition } from "../types";

export const SEARCH_VAULT_TOOL: CanonicalToolDefinition = {
  name: "search_vault",
  description:
    "Search the vault index for notes relevant to a query. Returns the most relevant chunks " +
    "with their source file, heading path, similarity score, and content. " +
    "Use this when you need information from the vault that wasn't in the initial context, " +
    "or to follow up on references found in previous results.",
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

/** All vault tools available in agentic mode. */
export const ALL_VAULT_TOOLS: CanonicalToolDefinition[] = [
  SEARCH_VAULT_TOOL,
  READ_NOTE_TOOL,
];

/** Names of vault tools — all are read-only (results returned to the model). */
export const VAULT_TOOL_NAMES = new Set(["search_vault", "read_note"]);

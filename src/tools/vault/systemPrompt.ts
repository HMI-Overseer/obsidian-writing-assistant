/**
 * System prompt addendum injected when vault tools are active.
 * Teaches the model how to handle tool errors for OpenAI-compatible providers,
 * which have no `is_error` semantic field — error signaling happens via content only.
 */
export const VAULT_TOOL_SYSTEM_PROMPT = `## Tool error handling
If a tool result begins with "Error:", the tool call failed:
- search_vault: retry with a rephrased or more specific query. Never repeat the same query exactly.
- read_note: if the note was not found, call search_vault first to locate the correct path, then retry read_note.
- After two consecutive errors toward the same goal, stop retrying and tell the user what failed and why.`;

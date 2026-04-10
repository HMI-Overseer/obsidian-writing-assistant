/**
 * System prompt addendum injected when vault tools are active.
 * Teaches the model how to handle tool errors for OpenAI-compatible providers,
 * which have no `is_error` semantic field — error signaling happens via content only.
 *
 * Pass `includeSemanticSearch: false` when the RAG index is not ready so the
 * model is not told to use a tool it cannot call.
 */
export function buildVaultToolSystemPrompt(includeSemanticSearch: boolean): string {
  const strategyLines = includeSemanticSearch
    ? `1. list_folder — discover what notes and folders exist (start here when exploring)
2. find_notes_by_tag — enumerate notes by type or category (e.g. #character, #location)
3. get_frontmatter — compare structured attributes across several notes without reading full content
4. get_backlinks — find every note that links to a given note (more reliable than search for explicit wikilink connections)
5. semantic_search — find notes by meaning when you know what you need but not where it lives
6. read_note — read the full content of a specific note once you know its path`
    : `1. list_folder — discover what notes and folders exist (start here when exploring)
2. find_notes_by_tag — enumerate notes by type or category (e.g. #character, #location)
3. get_frontmatter — compare structured attributes across several notes without reading full content
4. get_backlinks — find every note that links to a given note (more reliable than search for explicit wikilink connections)
5. read_note — read the full content of a specific note once you know its path`;

  const errorLines = includeSemanticSearch
    ? `- semantic_search: retry with a rephrased or more specific query. Never repeat the same query exactly.
- read_note / get_backlinks: if the note was not found, call list_folder or semantic_search first to locate the correct path.
- find_notes_by_tag: if no notes found, the result will suggest similar tags — try one of those.
- After two consecutive errors toward the same goal, stop retrying and tell the user what failed and why.`
    : `- read_note / get_backlinks: if the note was not found, call list_folder first to locate the correct path.
- find_notes_by_tag: if no notes found, the result will suggest similar tags — try one of those.
- After two consecutive errors toward the same goal, stop retrying and tell the user what failed and why.`;

  return `## Tool use — iterative exploration
Issue tool calls in small batches (2–3 per round). After each round you will receive the results before deciding what to look up next. Do not attempt to issue many tool calls in a single response — spread your research across multiple rounds.

## Exploration strategy
Use tools in order of increasing specificity:
${strategyLines}

## Tool error handling
If a tool result begins with "Error:", the tool call failed:
${errorLines}`;
}

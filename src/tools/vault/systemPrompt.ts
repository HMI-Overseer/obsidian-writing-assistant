import type { CanonicalToolDefinition } from "../types";

/**
 * Generate the vault tool system prompt addendum from the active tool list.
 *
 * The strategy section and error handling are derived entirely from the
 * `strategyHint` and `errorGuidance` fields on each tool definition, so the
 * prompt stays accurate automatically whenever tools are added, removed, or
 * filtered (e.g. semantic_search when the RAG index is not ready).
 */
export function buildVaultToolSystemPrompt(tools: CanonicalToolDefinition[]): string {
  const strategyLines = tools
    .filter((t) => t.strategyHint)
    .map((t, i) => `${i + 1}. ${t.name} — ${t.strategyHint}`)
    .join("\n");

  const errorEntries = tools
    .filter((t) => t.errorGuidance)
    .map((t) => `- ${t.name}: ${t.errorGuidance}`)
    .join("\n");

  const errorSection = errorEntries
    ? `If a tool result begins with "Error:", the tool call failed:\n${errorEntries}\n- After two consecutive errors toward the same goal, stop retrying and tell the user what failed and why.`
    : `If a tool result begins with "Error:", stop retrying after two attempts and tell the user what failed and why.`;

  return `## Tool use — iterative exploration
Issue tool calls in small batches (2–3 per round). After each round you will receive the results before deciding what to look up next. Do not attempt to issue many tool calls in a single response — spread your research across multiple rounds.

## Exploration strategy
Use tools in order of increasing specificity:
${strategyLines}

## Tool error handling
${errorSection}`;
}

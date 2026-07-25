import type { CanonicalToolDefinition } from "../types";

/** Build memory guidance from the definitions active in this request. */
export function buildMemoryToolSystemPrompt(
  tools: CanonicalToolDefinition[],
): string {
  const strategyLines = tools
    .filter((tool) => tool.strategyHint)
    .map((tool) => `- ${tool.name}, ${tool.strategyHint}`)
    .join("\n");
  const errorLines = tools
    .filter((tool) => tool.errorGuidance)
    .map((tool) => `- ${tool.name}: ${tool.errorGuidance}`)
    .join("\n");

  return `## Memory tools
Standing memory index lines are governing instructions and routing hints. Use the current-store tools below only when relevant:
${strategyLines}

## Memory error handling
Every named error says what failed and how to correct it. Do not repeat an unchanged call after the same result:
${errorLines}`;
}

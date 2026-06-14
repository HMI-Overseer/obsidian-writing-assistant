import type { CanonicalToolDefinition } from "../types";

/**
 * Generate the vault-operation system prompt addendum from the active tool list
 * (spec §12). Mirrors {@link buildVaultToolSystemPrompt}: the strategy and error
 * sections are derived entirely from each tool's `strategyHint`/`errorGuidance`,
 * so the prompt stays accurate when a class is denied and its tool is filtered out.
 *
 * The framing the model needs that the read tools don't: these tools change the
 * vault, but nothing is written while it works — every operation is proposed for
 * review, so it should issue the complete set of changes it intends.
 */
export function buildVaultOpToolSystemPrompt(tools: CanonicalToolDefinition[]): string {
  const strategyLines = tools
    .filter((t) => t.strategyHint)
    .map((t, i) => `${i + 1}. ${t.name} — ${t.strategyHint}`)
    .join("\n");

  const errorEntries = tools
    .filter((t) => t.errorGuidance)
    .map((t) => `- ${t.name}: ${t.errorGuidance}`)
    .join("\n");

  const errorSection = errorEntries
    ? `\n\n## When an operation is rejected\n${errorEntries}`
    : "";

  return `## Vault operations
These tools change the vault itself — creating, overwriting, moving, or trashing whole notes. Nothing is written to disk while you work: each call queues an operation that is shown to the user for review before it takes effect. Issue the complete set of changes you intend, then explain them.

## When to use them
${strategyLines}

## Guidance
- To change part of an existing note, prefer propose_edit. Reach for write_file only to create a new note or replace one wholesale.
- Always provide the complete file content for write_file — it replaces the file entirely, so partial content discards the rest.
- The review panel already shows every queued operation as a folder/file tree the user can inspect, so don't redraw it: skip ASCII diagrams or bullet lists that re-list the paths. Explain intent and trade-offs in prose instead.${errorSection}`;
}

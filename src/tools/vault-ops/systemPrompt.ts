import type { CanonicalToolDefinition } from "../types";

/**
 * Generate the vault-operation system prompt addendum from the active tool list
 * Mirrors {@link buildVaultToolSystemPrompt}: the strategy and error
 * sections are derived entirely from each tool's `strategyHint`/`errorGuidance`,
 * so the prompt stays accurate when a class is denied and its tool is filtered out.
 *
 * The framing the model needs that the read tools don't: these tools change the
 * vault, but nothing is written while it works, every operation is proposed for
 * review, so it should issue the complete set of changes it intends.
 */
export function buildVaultOpToolSystemPrompt(tools: CanonicalToolDefinition[]): string {
  const strategyLines = tools
    .filter((t) => t.strategyHint)
    .map((t, i) => `${i + 1}. ${t.name}, ${t.strategyHint}`)
    .join("\n");

  const errorEntries = tools
    .filter((t) => t.errorGuidance)
    .map((t) => `- ${t.name}: ${t.errorGuidance}`)
    .join("\n");

  const errorSection = errorEntries
    ? `\n\n## When an operation is rejected\nA tool result that begins with "Error:" means the operation failed; the rest of the line says why and what to try. After two consecutive errors toward the same goal, stop retrying and tell the user what failed and why.\n${errorEntries}`
    : `\n\n## When an operation is rejected\nA tool result that begins with "Error:" means the operation failed; the rest of the line says why and what to try. After two consecutive errors toward the same goal, stop retrying and tell the user what failed and why.`;

  return `## Vault operations
These tools change the vault itself, creating, overwriting, moving, or trashing whole notes. Nothing is written to disk while you work: each call queues an operation that is shown to the user for review before it takes effect. Issue the complete set of changes you intend, then explain them.

## When to use them
${strategyLines}

## Guidance
- To change part of an existing note, prefer edit. Reach for write_file only to create a new note or replace one wholesale.
- To rename a term, character, or place everywhere it appears, use replace_in_vault in a single call; there is no separate rename_in_vault tool. Its scope narrows all the way down: pass a folder, or a single note path, to limit it, or omit the scope to cover the whole vault. Never rewrite whole notes with write_file, or edit them one at a time, just to swap a recurring term.
- Renaming a note in full usually takes two tools together: move_file renames the note file itself and rewrites every [[wikilink]] to it, while replace_in_vault catches the plain-prose mentions of the old name in other notes. Pair them when the user renames something that is both a note title and a recurring word.
- Always provide the complete file content for write_file, it replaces the file entirely, so partial content discards the rest.
- The review panel already shows every queued operation as a folder/file tree the user can inspect, so don't redraw it: skip ASCII diagrams or bullet lists that re-list the paths. Explain intent and trade-offs in prose instead.${errorSection}`;
}

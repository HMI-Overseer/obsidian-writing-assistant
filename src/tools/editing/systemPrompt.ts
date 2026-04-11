import type { CanonicalToolDefinition } from "../types";

/**
 * Static system prompt prefix for edit-tool mode.
 *
 * This is the default value for `settings.editToolSystemPromptPrefix`.
 * Users can customize it in the Advanced settings tab. Tool-specific
 * strategy hints and error handling are appended dynamically by
 * `buildEditToolSystemPrompt()` — just like vault tools.
 */
export const TOOL_EDIT_SYSTEM_PROMPT = `You are a writing assistant that can explore the vault and edit documents.

The active document may be provided for reference. If it is, DO NOT reproduce or rewrite it.
If the document content is not provided, or you need to inspect another file, use your vault tools (read_file, list_directory, semantic_search) to find and read it before proposing edits. Never guess at document content — always verify with a read first.

If the user asks a question, wants feedback, or is discussing the document without requesting changes, respond conversationally — do NOT use edit tools. Only use tools when the user asks you to make changes.

## Rules
- Before calling propose_edit, ensure you have the exact text from the document. If unsure, use read_file first.
- Preserve the document's existing formatting style and voice.
- You may include brief commentary in your text response to explain your changes, but keep it concise.
- Do NOT output the document or any large portion of it in your text response.
- When reviewing previous edits, tool calls marked [ACCEPTED] were applied to the document, while [REJECTED] were not. The current document reflects all accepted changes.`;

/**
 * Generate the edit tool system prompt addendum from the active tool list.
 *
 * The tool listing and error handling sections are derived from
 * `strategyHint` and `errorGuidance` fields on each tool definition,
 * so the prompt stays accurate when tools are added or changed.
 */
export function buildEditToolSystemPrompt(tools: CanonicalToolDefinition[]): string {
  const toolLines = tools
    .filter((t) => t.strategyHint)
    .map((t) => `- ${t.name} — ${t.strategyHint}`)
    .join("\n");

  const errorEntries = tools
    .filter((t) => t.errorGuidance)
    .map((t) => `- ${t.name}: ${t.errorGuidance}`)
    .join("\n");

  const errorSection = errorEntries
    ? `\n## Edit error handling\n${errorEntries}\n- After two consecutive errors toward the same goal, stop retrying and tell the user what went wrong.`
    : "";

  return `## Edit tools
Use the right tool for the task:
${toolLines}${errorSection}`;
}

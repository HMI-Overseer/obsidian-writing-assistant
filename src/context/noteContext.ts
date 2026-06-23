import type { App } from "obsidian";

const MAX_CONTEXT_CHARS = 12000;

const TRUNCATION_MARKER = "[...note truncated...]";

/**
 * Which end of an over-budget note survives truncation.
 * - `"head"` keeps the opening (default): the conventional choice for reference
 *   context, where the title/frontmatter/opening orient the model.
 * - `"tail"` keeps the ending: for continuation, so the model can see where the
 *   note actually leaves off (front-truncation would discard exactly that).
 */
export type TruncateKeep = "head" | "tail";

/** Truncate note content to the context budget, marking the cut point. */
export function truncateNoteText(
  content: string,
  maxContextChars: number,
  keep: TruncateKeep = "head"
): string {
  if (content.length <= maxContextChars) return content;

  return keep === "tail"
    ? `${TRUNCATION_MARKER}\n\n${content.slice(content.length - maxContextChars)}`
    : `${content.slice(0, maxContextChars)}\n\n${TRUNCATION_MARKER}`;
}

export async function getActiveNoteText(
  app: App,
  maxContextChars: number = MAX_CONTEXT_CHARS,
  keep: TruncateKeep = "head"
): Promise<string | null> {
  const file = app.workspace.getActiveFile();
  if (!file) return null;

  const content = await app.vault.read(file);
  return truncateNoteText(content, maxContextChars, keep);
}

export async function getActiveNoteContext(
  app: App,
  maxContextChars: number = MAX_CONTEXT_CHARS,
  keep: TruncateKeep = "head"
): Promise<string | null> {
  const file = app.workspace.getActiveFile();
  if (!file) return null;

  const content = await getActiveNoteText(app, maxContextChars, keep);
  if (!content) return null;

  return `\n\n---\nCurrent note (${file.name}):\n${content}`;
}

export function getActiveFileName(app: App): string | null {
  return app.workspace.getActiveFile()?.name ?? null;
}

/**
 * Read the full content of the active note without any truncation.
 * Used by edit mode where the model needs the complete document.
 */
export async function getFullNoteContent(
  app: App
): Promise<{ content: string; filePath: string } | null> {
  const file = app.workspace.getActiveFile();
  if (!file) return null;

  const content = await app.vault.read(file);
  return { content, filePath: file.path };
}

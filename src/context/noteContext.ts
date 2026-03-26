import type { App } from "obsidian";

const MAX_CONTEXT_CHARS = 12000;

export async function getActiveNoteText(
  app: App,
  maxContextChars: number = MAX_CONTEXT_CHARS
): Promise<string | null> {
  const file = app.workspace.getActiveFile();
  if (!file) return null;

  const content = await app.vault.read(file);
  return content.length > maxContextChars
    ? content.slice(0, maxContextChars) + "\n\n[...note truncated...]"
    : content;
}

export async function getActiveNoteContext(
  app: App,
  maxContextChars: number = MAX_CONTEXT_CHARS
): Promise<string | null> {
  const file = app.workspace.getActiveFile();
  if (!file) return null;

  const content = await getActiveNoteText(app, maxContextChars);
  if (!content) return null;

  return `\n\n---\nCurrent note (${file.name}):\n${content}`;
}

export function getActiveFileName(app: App): string | null {
  return app.workspace.getActiveFile()?.name ?? null;
}

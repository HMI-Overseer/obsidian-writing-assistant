export interface TemplateContext {
  selection: string;
  noteText: string;
}

export function expandCommandTemplate(
  prompt: string,
  context: TemplateContext,
): string {
  return prompt
    .replace(/\{\{selection\}\}/g, context.selection)
    .replace(/\{\{note\}\}/g, context.noteText)
    .trim();
}

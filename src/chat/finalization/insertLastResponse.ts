import { Notice } from "obsidian";
import type WritingAssistantChat from "../../main";

export async function insertLastResponse(
  plugin: WritingAssistantChat,
  lastAssistantResponse: string,
): Promise<void> {
  if (!lastAssistantResponse) return;

  const editor = plugin.app.workspace.activeEditor?.editor;
  if (editor) {
    const selection = editor.getSelection();
    if (selection) {
      editor.replaceSelection(lastAssistantResponse);
    } else {
      const cursor = editor.getCursor("to");
      editor.replaceRange(`\n\n${lastAssistantResponse}`, cursor);
    }
    new Notice("Response inserted into note.");
    return;
  }

  const file = plugin.app.workspace.getActiveFile();
  if (file) {
    await plugin.app.vault.process(
      file,
      (content) => `${content}\n\n${lastAssistantResponse}`,
    );
    new Notice("Response appended to note.");
    return;
  }

  new Notice("No active note to insert into.");
}

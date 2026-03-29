import type { CompletionModel, Message } from "../../shared/types";
import { getActiveNoteContext, getFullNoteContent } from "../../context/noteContext";
import { EDIT_SYSTEM_PROMPT } from "../../editing/editSystemPrompt";
import type { App } from "obsidian";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";

export interface PrepareMessagesOptions {
  app: App;
  store: ChatSessionStore;
  activeModel: CompletionModel;
  includeNoteContext: boolean;
  sessionContextEnabled: boolean;
  maxContextChars: number;
  editMode?: boolean;
}

export async function prepareApiMessages(
  options: PrepareMessagesOptions
): Promise<Message[]> {
  const {
    app,
    store,
    activeModel,
    includeNoteContext,
    sessionContextEnabled,
    maxContextChars,
    editMode = false,
  } = options;

  let systemContent = activeModel.systemPrompt;

  if (editMode) {
    // Edit mode: append the edit instruction prompt and the full document
    systemContent += EDIT_SYSTEM_PROMPT;

    const noteData = await getFullNoteContent(app);
    if (noteData) {
      systemContent += `\n\n---\nDocument to edit (${noteData.filePath}):\n${noteData.content}`;
    }
  } else if (includeNoteContext && sessionContextEnabled) {
    const context = await getActiveNoteContext(app, maxContextChars);
    if (context) {
      systemContent += context;
    }
  }

  return [
    { role: "system", content: systemContent },
    ...store.getSnapshot().messageHistory.map((message) => ({
      role: message.role as "system" | "user" | "assistant",
      content: message.content,
    })),
  ];
}

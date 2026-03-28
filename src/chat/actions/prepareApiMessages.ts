import type { CompletionModel, Message } from "../../shared/types";
import { getActiveNoteContext } from "../../context/noteContext";
import type { App } from "obsidian";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";

export async function prepareApiMessages(
  app: App,
  store: ChatSessionStore,
  activeModel: CompletionModel,
  includeNoteContext: boolean,
  sessionContextEnabled: boolean,
  maxContextChars: number
): Promise<Message[]> {
  let systemContent = activeModel.systemPrompt;

  if (includeNoteContext && sessionContextEnabled) {
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

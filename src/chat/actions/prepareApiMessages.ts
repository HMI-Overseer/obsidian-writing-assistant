import type { CompletionModel, Message, ConversationMessage } from "../../shared/types";
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
      content: editMode && message.editProposal
        ? formatEditMessageContent(message)
        : message.content,
    })),
  ];
}

/**
 * Annotates an assistant message's SEARCH/REPLACE blocks with their
 * accept/reject outcomes so the model knows which edits were applied.
 */
function formatEditMessageContent(message: ConversationMessage): string {
  const { editProposal } = message;
  if (!editProposal) return message.content;

  let content = message.content;
  let acceptedCount = 0;
  let rejectedCount = 0;

  // Process hunks in reverse order of their position in the content string
  // so that earlier insertions don't shift the offsets of later ones.
  const hunkPositions = editProposal.hunks
    .map((hunk) => ({
      hunk,
      index: content.indexOf(hunk.resolvedEdit.editBlock.rawBlock),
    }))
    .filter((entry) => entry.index !== -1)
    .sort((a, b) => b.index - a.index);

  for (const { hunk, index } of hunkPositions) {
    const insertAt = index + hunk.resolvedEdit.editBlock.rawBlock.length;
    const annotation = hunk.status === "accepted"
      ? "\n[ACCEPTED — applied to document]"
      : "\n[REJECTED — not applied]";

    content = content.slice(0, insertAt) + annotation + content.slice(insertAt);

    if (hunk.status === "accepted") acceptedCount++;
    else rejectedCount++;
  }

  const total = acceptedCount + rejectedCount;
  if (total > 0) {
    content += `\n\n[Edit outcome: ${acceptedCount} accepted, ${rejectedCount} rejected out of ${total} proposed changes]`;
  }

  return content;
}

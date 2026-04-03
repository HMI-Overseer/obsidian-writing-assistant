import type { ConversationMessage } from "../../shared/types";
import type { ChatRequest, ChatTurn, DocumentContext, RagContextBlock } from "../../shared/chatRequest";
import { getActiveNoteText, getFullNoteContent } from "../../context/noteContext";
import { EDIT_SYSTEM_PROMPT } from "../../editing/editSystemPrompt";
import type { App } from "obsidian";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";
import type { RagService } from "../../rag";

export interface PrepareMessagesOptions {
  app: App;
  store: ChatSessionStore;
  globalSystemPrompt: string;
  includeNoteContext: boolean;
  sessionContextEnabled: boolean;
  maxContextChars: number;
  editMode?: boolean;
  ragService?: RagService;
}

export async function prepareApiMessages(
  options: PrepareMessagesOptions
): Promise<ChatRequest> {
  const {
    app,
    store,
    globalSystemPrompt,
    includeNoteContext,
    sessionContextEnabled,
    maxContextChars,
    editMode = false,
    ragService,
  } = options;

  const systemPrompt = editMode ? EDIT_SYSTEM_PROMPT : globalSystemPrompt;

  let documentContext: DocumentContext | null = null;

  if (editMode) {
    const noteData = await getFullNoteContent(app);
    if (noteData) {
      documentContext = {
        filePath: noteData.filePath,
        content: noteData.content,
        isFull: true,
      };
    }
  } else if (includeNoteContext && sessionContextEnabled) {
    const file = app.workspace.getActiveFile();
    if (file) {
      const text = await getActiveNoteText(app, maxContextChars);
      if (text) {
        documentContext = {
          filePath: file.path,
          content: text,
          isFull: false,
        };
      }
    }
  }

  const messages: ChatTurn[] = store.getSnapshot().messageHistory.map((message) => ({
    role: message.role as "user" | "assistant",
    content: editMode && message.editProposal
      ? formatEditMessageContent(message)
      : message.content,
  }));

  // Retrieve RAG context based on the latest user message.
  let ragContext: RagContextBlock[] | null = null;
  if (!editMode && ragService?.isReady()) {
    const lastUserMessage = messages.findLast((m) => m.role === "user");
    if (lastUserMessage) {
      const activeFile = app.workspace.getActiveFile();
      ragContext = await ragService.retrieve(lastUserMessage.content, activeFile?.path);
    }
  }

  // When RAG context is present, add a grounding instruction so the model
  // knows retrieved notes exist and should be consulted as reference material.
  const finalSystemPrompt = ragContext && ragContext.length > 0
    ? systemPrompt + "\n\nWhen retrieved notes are provided, use them as reference material. If the retrieved notes don't contain relevant information for the question, rely on your general knowledge instead."
    : systemPrompt;

  return { systemPrompt: finalSystemPrompt, documentContext, ragContext, messages };
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

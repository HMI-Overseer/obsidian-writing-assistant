import type { ConversationMessage, PluginSettings, ProviderOption } from "../../shared/types";
import type { ChatRequest, ChatTurn, DocumentContext, RagContextBlock } from "../../shared/chatRequest";
import { getActiveNoteText, getFullNoteContent } from "../../context/noteContext";
import { shouldUseToolCall } from "../../tools/registry";
import { ALL_EDIT_TOOLS } from "../../tools/editing/definition";
import type { ChatMode } from "../types";
import type { App } from "obsidian";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";
import type { RagService } from "../../rag";

export interface PrepareMessagesOptions {
  app: App;
  store: ChatSessionStore;
  settings: PluginSettings;
  includeNoteContext: boolean;
  sessionContextEnabled: boolean;
  maxContextChars: number;
  mode: ChatMode;
  ragService?: RagService;
  /** Active provider — needed to decide tool use in edit mode. */
  activeProvider?: ProviderOption;
  /** Per-model capabilities (LM Studio). */
  modelCapabilities?: { trainedForToolUse?: boolean };
}

export async function prepareApiMessages(
  options: PrepareMessagesOptions
): Promise<ChatRequest> {
  const {
    app,
    store,
    settings,
    includeNoteContext,
    sessionContextEnabled,
    maxContextChars,
    mode,
    ragService,
    activeProvider,
    modelCapabilities,
  } = options;

  const editMode = mode === "edit";
  const useToolUse = editMode && !!activeProvider
    && shouldUseToolCall(activeProvider, modelCapabilities);
  const systemPrompt = composeSystemPrompt(mode, useToolUse, settings);

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
  let groundingNote = "";
  if (ragContext && ragContext.length > 0) {
    const hasGraphAnnotations = ragContext.some((b) => b.graphContext);
    groundingNote = hasGraphAnnotations
      ? "\n\nWhen retrieved notes are provided, use them as reference material. Documents may include <graph_context> annotations showing entities and relationships from the vault's knowledge graph — use these to understand how topics connect across documents."
      : "\n\nWhen retrieved notes are provided, use them as reference material. If the retrieved notes don't contain relevant information for the question, rely on your general knowledge instead.";
  }
  const finalSystemPrompt = systemPrompt + groundingNote;

  const tools = useToolUse ? ALL_EDIT_TOOLS : undefined;

  return { systemPrompt: finalSystemPrompt, documentContext, ragContext, messages, tools };
}

/**
 * Combines a mode-specific prefix with the user's custom prompt.
 * `useToolUse` selects between the tool vs fallback edit prefix.
 */
export function composeSystemPrompt(
  mode: ChatMode,
  useToolUse: boolean,
  settings: PluginSettings,
): string {
  let prefix: string;
  switch (mode) {
    case "plan":
      prefix = settings.planSystemPromptPrefix;
      break;
    case "conversation":
      prefix = settings.chatSystemPromptPrefix;
      break;
    case "edit":
      prefix = useToolUse
        ? settings.editToolSystemPromptPrefix
        : settings.editFallbackSystemPromptPrefix;
      break;
  }

  const userPrompt = settings.globalSystemPrompt;
  return [prefix, userPrompt].filter(Boolean).join("\n\n");
}

/**
 * Annotates an assistant message's edit blocks with their accept/reject
 * outcomes so the model knows which edits were applied.
 *
 * For regex-parsed messages: rawBlocks are found in the content string and
 * annotated inline. For tool-call messages: a summary is appended since the
 * content is pure prose with no embedded blocks.
 */
function formatEditMessageContent(message: ConversationMessage): string {
  const { editProposal } = message;
  if (!editProposal) return message.content;

  // Tool-call messages: content is pure prose — annotate with a summary.
  if (message.toolCalls && message.toolCalls.length > 0) {
    return formatToolCallEditHistory(message.content, editProposal);
  }

  // Regex-parsed messages: annotate inline SEARCH/REPLACE rawBlocks.
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

/**
 * Builds history text for a tool-call-based edit message.
 * Appends a per-hunk summary so the model knows what was accepted/rejected.
 */
function formatToolCallEditHistory(prose: string, proposal: EditProposal): string {
  const parts: string[] = [];
  if (prose) parts.push(prose);

  let acceptedCount = 0;
  let rejectedCount = 0;

  for (const hunk of proposal.hunks) {
    const status = hunk.status === "accepted" ? "ACCEPTED" : "REJECTED";
    const search = hunk.resolvedEdit.editBlock.searchText;
    const preview = search.length > 80 ? search.slice(0, 80) + "..." : search;
    parts.push(`[Edit: "${preview}" — ${status}]`);

    if (hunk.status === "accepted") acceptedCount++;
    else rejectedCount++;
  }

  const total = acceptedCount + rejectedCount;
  if (total > 0) {
    parts.push(`[Edit outcome: ${acceptedCount} accepted, ${rejectedCount} rejected out of ${total} proposed changes]`);
  }

  return parts.join("\n\n");
}

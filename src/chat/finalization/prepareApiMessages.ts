import type { ConversationMessage, PluginSettings, ProviderOption } from "../../shared/types";
import type { AdditionalContextItem, ChatRequest, ChatTurn, DocumentContext, ExtraContextItem, RagContextBlock } from "../../shared/chatRequest";
import { getActiveNoteText, getFullNoteContent } from "../../context/noteContext";
import { shouldUseToolCall } from "../../tools/registry";
import { ALL_EDIT_TOOLS, EDIT_TOOL_NAMES } from "../../tools/editing/definition";
import { buildEditToolSystemPrompt } from "../../tools/editing/systemPrompt";
import { ALL_VAULT_TOOLS, CORE_VAULT_TOOLS, VAULT_TOOL_NAMES } from "../../tools/vault/definition";
import { THINK_TOOL } from "../../tools/think/definition";
import { buildVaultToolSystemPrompt } from "../../tools/vault/systemPrompt";
import type { CanonicalToolDefinition } from "../../tools/types";
import type { ChatMode } from "../types";
import type { App } from "obsidian";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";
import type { RagService } from "../../rag";
import type { ChatClient } from "../../api/chatClient";
import { rewriteQueryForRetrieval } from "../../rag/queryRewriter";
import type { EditProposal } from "../../editing/editTypes";

export interface PrepareMessagesOptions {
  app: App;
  store: ChatSessionStore;
  settings: PluginSettings;
  /** Whether the active note is currently attached (replaces includeNoteContext + sessionContextEnabled). */
  activeNoteAttached: boolean;
  /** Extra vault notes manually attached by the user via the context picker. */
  extraContextItems: ExtraContextItem[];
  maxContextChars: number;
  mode: ChatMode;
  ragService?: RagService;
  /** Active provider — needed to decide tool use. */
  activeProvider?: ProviderOption;
  /** Per-model capabilities (LM Studio). */
  modelCapabilities?: { trainedForToolUse?: boolean };
  /** Whether the active model supports vision (image input). */
  supportsVision?: boolean;
  /** Chat client for internal LLM calls (query rewriting). */
  chatClient?: ChatClient;
  /** Completion model ID for internal LLM calls. */
  completionModelId?: string;
  /** System prompt from the active provider profile. */
  profileSystemPrompt?: string;
  /** When true, all built-in additions are omitted — only profileSystemPrompt is sent. */
  disableBuiltinSystemPrompts?: boolean;
}

export async function prepareApiMessages(
  options: PrepareMessagesOptions
): Promise<ChatRequest> {
  const {
    app,
    store,
    settings,
    activeNoteAttached,
    extraContextItems,
    maxContextChars,
    mode,
    ragService,
    activeProvider,
    modelCapabilities,
    chatClient,
    completionModelId,
    profileSystemPrompt = "",
    disableBuiltinSystemPrompts = false,
    supportsVision = false,
  } = options;

  const editMode = mode === "edit";
  const modelCanUseTools = !!activeProvider && shouldUseToolCall(activeProvider, modelCapabilities);
  const useVaultTools = settings.agenticMode && modelCanUseTools;
  const useEditTools = editMode && settings.agenticMode && modelCanUseTools && settings.preferToolUse;

  const systemPrompt = composeSystemPrompt(mode, useEditTools, settings, profileSystemPrompt);

  let documentContext: DocumentContext | null = null;

  if (editMode && activeNoteAttached) {
    const noteData = await getFullNoteContent(app);
    if (noteData) {
      documentContext = {
        filePath: noteData.filePath,
        content: noteData.content,
        isFull: true,
      };
    }
  } else if (activeNoteAttached) {
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

  // Resolve extra vault-note items attached via the context picker.
  let additionalContextItems: AdditionalContextItem[] | undefined;
  if (extraContextItems.length > 0) {
    const resolved: AdditionalContextItem[] = [];
    for (const item of extraContextItems) {
      const file = app.vault.getFileByPath(item.filePath);
      if (!file) continue;
      const raw = await app.vault.read(file);
      const content = raw.length > maxContextChars
        ? raw.slice(0, maxContextChars) + "\n\n[...note truncated...]"
        : raw;
      resolved.push({ filePath: item.filePath, fileName: item.fileName, content });
    }
    if (resolved.length > 0) additionalContextItems = resolved;
  }

  const messages: ChatTurn[] = store
    .getSnapshot()
    .messageHistory.filter((message) => !message.isError)
    .map((message) => ({
      role: message.role as "user" | "assistant",
      content: editMode && message.editProposal
        ? formatEditMessageContent(message)
        : message.content,
      ...(supportsVision && message.attachments?.length && { attachments: message.attachments }),
    }));

  // Retrieve RAG context based on the latest user message.
  // Skipped when vault tools are active — in agentic mode the model controls
  // retrieval itself via semantic_search. Pre-injecting context causes the model
  // to answer from the warm-start content and never call the tool.
  let ragContext: RagContextBlock[] | null = null;
  let rewrittenQuery: string | undefined;
  if (!editMode && !useVaultTools && ragService?.isReady()) {
    const lastUserMessage = [...messages].reverse().find((m: ChatTurn) => m.role === "user");
    if (lastUserMessage?.content) {
      let retrievalQuery = lastUserMessage.content;
      if (chatClient && completionModelId) {
        retrievalQuery = await rewriteQueryForRetrieval(
          lastUserMessage.content,
          messages,
          chatClient,
          completionModelId,
        );
        if (retrievalQuery !== lastUserMessage.content) {
          rewrittenQuery = retrievalQuery;
        }
      }
      ragContext = await ragService.retrieve(retrievalQuery, documentContext?.filePath);
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
  // Build the tool list based on mode and agentic settings.
  //
  // Vault tool tiers:
  //   CORE_VAULT_TOOLS  — list_directory, read_file, semantic_search
  //                       Used in edit mode (focused task) and for local models.
  //   ALL_VAULT_TOOLS   — core + get_backlinks, find_notes_by_tag, get_frontmatter
  //                       Used in chat/plan mode with cloud providers (full exploration).
  //
  // Edit tools are added on top in edit mode when preferToolUse is also on.
  // Cloud providers get the full edit tool set; local models get a reduced set.
  // think is a meta-reasoning tool that benefits large cloud models.
  // LM Studio (local models) already struggle with multi-tool schemas, and
  // Magistral-family reasoning models conflict with a tool named "think" via
  // lmstudio-ai/lmstudio-bug-tracker#1592.
  const useThinkTool = activeProvider !== "lmstudio";

  let tools: CanonicalToolDefinition[] | undefined;
  if (useEditTools) {
    // Edit mode: focused document task — core vault tools for context lookup only.
    const editTools = ALL_EDIT_TOOLS;
    tools = [...CORE_VAULT_TOOLS, ...editTools, ...(useThinkTool ? [THINK_TOOL] : [])];
  } else if (useVaultTools) {
    tools = [...ALL_VAULT_TOOLS, ...(useThinkTool ? [THINK_TOOL] : [])];
  }

  // semantic_search requires a built RAG index. Remove it when unavailable so
  // the model is forced to use structural tools instead of burning rounds on
  // guaranteed failures.
  if (tools && !ragService?.isReady()) {
    tools = tools.filter((t) => t.name !== "semantic_search");
  }

  // Build tool guidance from the filtered tool lists so the system prompt
  // accurately reflects what is actually available (e.g. no semantic_search
  // when the RAG index is not ready).
  const activeVaultTools = (tools ?? []).filter((t) => VAULT_TOOL_NAMES.has(t.name));
  const vaultGuidance = useVaultTools ? "\n\n" + buildVaultToolSystemPrompt(activeVaultTools) : "";
  const activeEditTools = (tools ?? []).filter((t) => EDIT_TOOL_NAMES.has(t.name));
  const editGuidance = useEditTools ? "\n\n" + buildEditToolSystemPrompt(activeEditTools) : "";
  const finalSystemPrompt = disableBuiltinSystemPrompts
    ? profileSystemPrompt
    : systemPrompt + groundingNote + vaultGuidance + editGuidance;

  return { systemPrompt: finalSystemPrompt, documentContext, ragContext, rewrittenQuery, messages, tools, additionalContextItems };
}

/**
 * Combines a mode-specific prefix with the user's custom prompt from the active profile.
 * `useEditTools` selects between the tool vs fallback edit prefix.
 */
export function composeSystemPrompt(
  mode: ChatMode,
  useEditTools: boolean,
  settings: PluginSettings,
  profileSystemPrompt: string,
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
      prefix = useEditTools
        ? settings.editToolSystemPromptPrefix
        : settings.editFallbackSystemPromptPrefix;
      break;
  }

  return [prefix, profileSystemPrompt].filter(Boolean).join("\n\n");
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

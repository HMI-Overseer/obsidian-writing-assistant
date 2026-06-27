import type { ConversationMessage, PluginSettings, ProviderOption } from "../../shared/types";
import type { AdditionalContextItem, ChatRequest, ChatTurn, DocumentContext, ExtraContextItem, RagContextBlock } from "../../shared/chatRequest";
import { getFullNoteContent, truncateNoteText } from "../../context/noteContext";
import { resolveNoteImageContext } from "../../context/noteImageContext";
import { shouldUseToolCall } from "../../tools/registry";
import { EDIT_TOOL_NAMES } from "../../tools/editing/definition";
import { buildEditToolSystemPrompt } from "../../tools/editing/systemPrompt";
import {
  VAULT_TOOL_NAMES,
  filterSemanticSearchByAvailability,
} from "../../tools/vault/definition";
import { VAULT_OPS_TOOL_NAMES } from "../../tools/vault-ops/definition";
import { buildVaultOpToolSystemPrompt } from "../../tools/vault-ops/systemPrompt";
import { buildVaultToolSystemPrompt } from "../../tools/vault/systemPrompt";
import {
  CLOUD_STABLE_TOOL_SET,
  cloudAllowedToolNames,
  cloudAllowedToolSet,
  resolveLocalToolSet,
} from "../../tools/toolSurface";
import type { CanonicalToolDefinition } from "../../tools/types";
import type { ChatMode } from "../types";
import type { App, TFile } from "obsidian";
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
  /** Active provider, needed to decide tool use. */
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
  /** When true, all built-in additions are omitted, only profileSystemPrompt is sent. */
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
  // Claude Code reports as tool-capable, but it bridges the plugin's tools via its
  // own MCP server and runs its own agent loop, so the plugin never attaches
  // CanonicalToolDefinition tools (request.tools) or spins up its tool loop/timeline
  // for it. When agentic is on, Claude Code retrieves through MCP itself.
  const isClaudeCode = activeProvider === "claudecode";
  const modelCanUseTools = !!activeProvider && shouldUseToolCall(activeProvider, modelCapabilities);
  const usePluginTools = modelCanUseTools && !isClaudeCode;
  const useVaultTools = settings.agenticMode && usePluginTools;
  const useEditTools = editMode && settings.agenticMode && usePluginTools && settings.preferToolUse;
  const claudeCodeRetrievesViaMcp = isClaudeCode && settings.agenticMode;

  const modePrefix = selectModePrefix(mode, useEditTools, settings);
  const systemPrompt = [modePrefix, profileSystemPrompt].filter(Boolean).join("\n\n");
  const shouldIncludeNoteImages =
    settings.includeLocalAttachmentsAsContext && supportsVision;

  // Chat/plan mode attaches notes as frozen snapshots on the user turn (see
  // snapshotNoteAttachments), they ride message.attachments below, not the
  // system prefix. Only edit mode still sends a live document/extra notes here,
  // re-read each turn because the diff engine matches against the current file.
  let documentContext: DocumentContext | null = null;
  let additionalContextItems: AdditionalContextItem[] | undefined;
  const noteImageSources: Array<{ file: TFile; rawContent: string }> = [];

  if (editMode && activeNoteAttached) {
    const noteData = await getFullNoteContent(app);
    if (noteData) {
      documentContext = {
        filePath: noteData.filePath,
        content: noteData.content,
        isFull: true,
      };
      const file = app.workspace.getActiveFile();
      if (shouldIncludeNoteImages && file) {
        noteImageSources.push({ file, rawContent: noteData.content });
      }
    }
  }

  if (editMode && extraContextItems.length > 0) {
    const resolved: AdditionalContextItem[] = [];
    for (const item of extraContextItems) {
      const file = app.vault.getFileByPath(item.filePath);
      if (!file) continue;
      const raw = await app.vault.read(file);
      const content = truncateNoteText(raw, maxContextChars);
      resolved.push({ filePath: item.filePath, fileName: item.fileName, content });
      if (shouldIncludeNoteImages) {
        noteImageSources.push({ file, rawContent: raw });
      }
    }
    if (resolved.length > 0) additionalContextItems = resolved;
  }

  const noteImageContext = shouldIncludeNoteImages && noteImageSources.length > 0
    ? await resolveNoteImageContext(app, noteImageSources)
    : undefined;

  // The active file is excluded from RAG retrieval. In edit mode it's the
  // documentContext; in chat mode the note now lives in an attachment, so read
  // the current active file directly.
  const activeFilePath = documentContext?.filePath ?? app.workspace.getActiveFile()?.path;

  const messages: ChatTurn[] = store
    .getSnapshot()
    .messageHistory.filter((message) => !message.isError)
    .map((message) => {
      // Note snapshots always travel with the turn; image attachments only go to
      // vision-capable models.
      const attachments = message.attachments?.filter(
        (a) => a.type !== "image" || supportsVision,
      );
      return {
        role: message.role as "user" | "assistant",
        content: editMode && message.editProposal
          ? formatEditMessageContent(message)
          : message.content,
        ...(attachments?.length ? { attachments } : {}),
      };
    });

  // Retrieve RAG context based on the latest user message.
  // Skipped when vault tools are active, in agentic mode the model controls
  // retrieval itself via semantic_search. Pre-injecting context causes the model
  // to answer from the warm-start content and never call the tool.
  // Also skipped for agentic Claude Code: it retrieves through the plugin's MCP
  // tools, so pre-injecting would duplicate context and discourage it from
  // searching. A non-agentic Claude Code run has no tools, so RAG still helps.
  let ragContext: RagContextBlock[] | null = null;
  let rewrittenQuery: string | undefined;
  if (!editMode && !useVaultTools && !claudeCodeRetrievesViaMcp && ragService?.isReady()) {
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
      // Pre-injection is best-effort: if the embedding backend is unreachable,
      // retrieve() throws. Degrade silently to no context here, the in-loop
      // semantic_search tool is the surface that reports the failure to the model.
      try {
        ragContext = await ragService.retrieve(retrievalQuery, activeFilePath);
      } catch {
        ragContext = null;
      }
    }
  }

  // When RAG context is present, add a grounding instruction so the model knows
  // retrieved notes exist. The body is kept separator-free so it can join the
  // mode tail cleanly; the local path re-adds the leading "\n\n".
  let groundingNoteBody = "";
  if (ragContext && ragContext.length > 0) {
    const hasGraphAnnotations = ragContext.some((b) => b.graphContext);
    groundingNoteBody = hasGraphAnnotations
      ? "When retrieved notes are provided, use them as reference material. Documents may include <graph_context> annotations showing entities and relationships from the vault's knowledge graph, use these to understand how topics connect across documents."
      : "When retrieved notes are provided, use them as reference material. If the retrieved notes don't contain relevant information for the question, rely on your general knowledge instead.";
  }
  const groundingNote = groundingNoteBody ? "\n\n" + groundingNoteBody : "";
  // Build the tool surface. The only mode/policy-varying decision is the write gate
  // (which mutating tools a mode permits); reads are unrestricted on the cloud paths.
  // The canonical resolver lives in src/tools/toolSurface.ts so every path reads one
  // source (prompt-cache design §6.1.1/§6.1.4/§6.1.5).
  //
  // think is a meta-reasoning tool that benefits large cloud models. LM Studio (local
  // models) already struggle with multi-tool schemas, and Magistral-family reasoning
  // models conflict with a tool named "think" (lmstudio-ai/lmstudio-bug-tracker#1592),
  // so it is excluded there.
  const useThinkTool = activeProvider !== "lmstudio";
  const surfaceOpts = {
    editMode,
    preferToolUse: settings.preferToolUse,
    policy: settings.vaultOpPolicy,
    useThinkTool,
  };
  const availability = ragService?.availability() ?? "no-backend";

  // Emission diverges by path. The direct Anthropic path emits the full stable
  // superset and holds it byte-identical across modes (Layer 1, keeps the prompt
  // cache warm); a runtime allow-list (allowedToolNames, enforced in the tool loop)
  // restricts what may actually be called, so mode/policy never shrink the emitted
  // block. semantic_search stays in the superset and reports unavailability at call
  // time. Local providers keep their lean per-mode materialization (no caching
  // incentive, smaller menu = better selection); for them the emitted set already is
  // the allowed set, and the shared filter drops semantic_search when the backend is
  // cold (so the two routes can't drift, the original defect).
  let tools: CanonicalToolDefinition[] | undefined;
  let allowedToolNames: string[] | undefined;
  // The tools whose guidance the mode tail describes: what the model may actually use
  // this mode (the allowed subset on cloud, the emitted lean set on local).
  let guidanceTools: CanonicalToolDefinition[] = [];
  if (useVaultTools) {
    if (activeProvider === "anthropic") {
      tools = CLOUD_STABLE_TOOL_SET;
      allowedToolNames = cloudAllowedToolNames(surfaceOpts);
      guidanceTools = filterSemanticSearchByAvailability(cloudAllowedToolSet(surfaceOpts), availability);
    } else {
      const lean = filterSemanticSearchByAvailability(resolveLocalToolSet(surfaceOpts), availability);
      tools = lean;
      guidanceTools = lean;
    }
  }

  // Build tool guidance from guidanceTools so the mode tail accurately reflects what
  // the model may use (e.g. no semantic_search when the RAG index is not ready, and
  // only the mode's permitted writes). Each body is kept separator-free for the mode
  // tail; the local path re-adds the leading "\n\n" to preserve its bytes.
  const activeVaultTools = guidanceTools.filter((t) => VAULT_TOOL_NAMES.has(t.name));
  const vaultGuidanceBody = useVaultTools ? buildVaultToolSystemPrompt(activeVaultTools) : "";
  const vaultGuidance = useVaultTools ? "\n\n" + vaultGuidanceBody : "";
  const activeEditTools = guidanceTools.filter((t) => EDIT_TOOL_NAMES.has(t.name));
  const editGuidanceBody = useEditTools ? buildEditToolSystemPrompt(activeEditTools) : "";
  const editGuidance = useEditTools ? "\n\n" + editGuidanceBody : "";
  const activeVaultOpTools = guidanceTools.filter((t) => VAULT_OPS_TOOL_NAMES.has(t.name));
  const vaultOpGuidanceBody = activeVaultOpTools.length > 0
    ? buildVaultOpToolSystemPrompt(activeVaultOpTools)
    : "";
  const vaultOpGuidance = activeVaultOpTools.length > 0 ? "\n\n" + vaultOpGuidanceBody : "";
  const finalSystemPrompt = disableBuiltinSystemPrompts
    ? profileSystemPrompt
    : systemPrompt + groundingNote + vaultGuidance + editGuidance + vaultOpGuidance;

  // Layer 1 (prompt-cache design §6.1.2): on the billed paths that have a tail
  // mechanism, hold the cached `system` block mode-invariant (profile prompt
  // only) and carry the per-mode wording + tool guidance in the message tail.
  // Local providers (and disableBuiltinSystemPrompts) keep today's full system
  // prompt, byte-for-byte, with no tail. The clients place modeTail in their own
  // tail mechanism (see ChatRequest.modeTail).
  const useModeTail =
    !disableBuiltinSystemPrompts &&
    (activeProvider === "anthropic" || isClaudeCode);
  const { systemPrompt: outSystemPrompt, modeTail } = splitSystemForTail({
    useModeTail,
    fullSystemPrompt: finalSystemPrompt,
    cachedSystemPrompt: profileSystemPrompt,
    tailParts: [modePrefix, groundingNoteBody, vaultGuidanceBody, editGuidanceBody, vaultOpGuidanceBody],
  });

  return {
    systemPrompt: outSystemPrompt,
    ...(modeTail ? { modeTail } : {}),
    documentContext,
    ragContext,
    rewrittenQuery,
    messages,
    tools,
    ...(allowedToolNames ? { allowedToolNames } : {}),
    additionalContextItems,
    ...(noteImageContext?.length ? { noteImageContext } : {}),
  };
}

/**
 * Selects the mode-specific prompt prefix. `useEditTools` selects between the
 * tool vs fallback edit prefix. This is the per-mode wording that Layer 1 moves
 * out of the cached `system` block and into the message tail (see
 * {@link splitSystemForTail}).
 */
export function selectModePrefix(
  mode: ChatMode,
  useEditTools: boolean,
  settings: PluginSettings,
): string {
  switch (mode) {
    case "plan":
      return settings.planSystemPromptPrefix;
    case "conversation":
      return settings.chatSystemPromptPrefix;
    case "edit":
      return useEditTools
        ? settings.editToolSystemPromptPrefix
        : settings.editFallbackSystemPromptPrefix;
  }
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
  return [selectModePrefix(mode, useEditTools, settings), profileSystemPrompt]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Layer 1 decomposition of the system prompt into a mode-invariant cached block
 * and a per-mode tail (prompt-cache design §6.1.2).
 *
 * When `useModeTail` is false (local providers, or built-in prompts disabled),
 * returns today's full system prompt unchanged with no tail. When true, the
 * cached `system` becomes the profile prompt only and the per-mode pieces
 * (`tailParts`, in render order) are joined into `modeTail`. An all-empty tail
 * yields `modeTail: undefined` so callers never emit an empty block.
 */
export function splitSystemForTail(opts: {
  useModeTail: boolean;
  fullSystemPrompt: string;
  cachedSystemPrompt: string;
  tailParts: string[];
}): { systemPrompt: string; modeTail?: string } {
  if (!opts.useModeTail) {
    return { systemPrompt: opts.fullSystemPrompt };
  }
  const modeTail = opts.tailParts.filter(Boolean).join("\n\n");
  return {
    systemPrompt: opts.cachedSystemPrompt,
    ...(modeTail ? { modeTail } : {}),
  };
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

  // Tool-call messages: content is pure prose, annotate with a summary.
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
      ? "\n[ACCEPTED, applied to document]"
      : "\n[REJECTED, not applied]";

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
    parts.push(`[Edit: "${preview}", ${status}]`);

    if (hunk.status === "accepted") acceptedCount++;
    else rejectedCount++;
  }

  const total = acceptedCount + rejectedCount;
  if (total > 0) {
    parts.push(`[Edit outcome: ${acceptedCount} accepted, ${rejectedCount} rejected out of ${total} proposed changes]`);
  }

  return parts.join("\n\n");
}

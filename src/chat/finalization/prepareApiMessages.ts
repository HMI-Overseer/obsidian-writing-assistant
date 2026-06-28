import type { ConversationMessage, PluginSettings, ProviderOption, ApprovalPosture } from "../../shared/types";
import type { ChatRequest, ChatTurn, RagContextBlock } from "../../shared/chatRequest";
import { shouldUseToolCall } from "../../tools/registry";
import { EDIT_TOOL_NAMES } from "../../tools/editing/definition";
import { buildEditToolSystemPrompt } from "../../tools/editing/systemPrompt";
import { EDIT_SYSTEM_PROMPT } from "../../editing/regexEditSystemPrompt";
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
import { writesPermitted } from "../../vault-ops/gateway";
import type { CanonicalToolDefinition } from "../../tools/types";
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
  /** Session approval posture, the cloud surface's replacement for the plan/chat/edit mode (§6.3). */
  posture: ApprovalPosture;
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
    posture,
    ragService,
    activeProvider,
    modelCapabilities,
    chatClient,
    completionModelId,
    profileSystemPrompt = "",
    disableBuiltinSystemPrompts = false,
    supportsVision = false,
  } = options;

  // Claude Code reports as tool-capable, but it bridges the plugin's tools via its
  // own MCP server and runs its own agent loop, so the plugin never attaches
  // CanonicalToolDefinition tools (request.tools) or spins up its tool loop/timeline
  // for it. When agentic is on, Claude Code retrieves through MCP itself.
  const isClaudeCode = activeProvider === "claudecode";
  const modelCanUseTools = !!activeProvider && shouldUseToolCall(activeProvider, modelCapabilities);
  const usePluginTools = modelCanUseTools && !isClaudeCode;
  const useVaultTools = settings.agenticMode && usePluginTools;
  const claudeCodeRetrievesViaMcp = isClaudeCode && settings.agenticMode;

  // Ambient editing (prompt-cache design §6.3): with the plan/chat/edit modes gone, one
  // unified system prefix frames every turn. A non-agentic turn (no tools) still edits,
  // via SEARCH/REPLACE blocks the diff engine parses, so it carries the regex-edit format
  // guidance whenever editing is permitted but no tools carry it.
  const editsPermitted = writesPermitted(settings.vaultOpPolicy, posture);
  const useRegexEditGuidance = !useVaultTools && !claudeCodeRetrievesViaMcp && editsPermitted;

  const basePrefix = settings.systemPromptPrefix;
  const systemPrompt = [basePrefix, profileSystemPrompt].filter(Boolean).join("\n\n");

  // The active note + extra notes (and their embedded images) are frozen into a
  // point-in-time snapshot bound to the user turn at send time (snapshotNoteAttachments),
  // so they ride message.attachments and stay cache-stable. There is no live re-read of
  // the active document here, the model reads current content via tools when it edits
  // (the §10/§13 cache-coupling anti-pattern is gone).
  const activeFilePath = app.workspace.getActiveFile()?.path;

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
        content: message.editProposal
          ? formatEditMessageContent(message)
          : message.content,
        ...(attachments?.length ? { attachments } : {}),
      };
    });

  // Retrieve RAG context based on the latest user message. Skipped when vault tools are
  // active: in agentic mode the model controls retrieval itself via semantic_search, and
  // pre-injecting context causes it to answer from the warm-start content and never call
  // the tool. Also skipped for agentic Claude Code (it retrieves through the plugin's MCP
  // tools). A non-agentic run has no tools, so RAG still helps.
  let ragContext: RagContextBlock[] | null = null;
  let rewrittenQuery: string | undefined;
  if (!useVaultTools && !claudeCodeRetrievesViaMcp && ragService?.isReady()) {
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
  // tail cleanly; the local path re-adds the leading "\n\n".
  let groundingNoteBody = "";
  if (ragContext && ragContext.length > 0) {
    const hasGraphAnnotations = ragContext.some((b) => b.graphContext);
    groundingNoteBody = hasGraphAnnotations
      ? "When retrieved notes are provided, use them as reference material. Documents may include <graph_context> annotations showing entities and relationships from the vault's knowledge graph, use these to understand how topics connect across documents."
      : "When retrieved notes are provided, use them as reference material. If the retrieved notes don't contain relevant information for the question, rely on your general knowledge instead.";
  }
  const groundingNote = groundingNoteBody ? "\n\n" + groundingNoteBody : "";

  // Build the tool surface. The only posture/policy-varying decision is the write gate
  // (which mutating tools the session permits); reads are unrestricted on the cloud
  // paths. The canonical resolver lives in src/tools/toolSurface.ts so every path reads
  // one source (prompt-cache design §6.1.1/§6.1.4/§6.1.5).
  //
  // think is a meta-reasoning tool that benefits large cloud models. LM Studio (local
  // models) already struggle with multi-tool schemas, and Magistral-family reasoning
  // models conflict with a tool named "think" (lmstudio-ai/lmstudio-bug-tracker#1592),
  // so it is excluded there.
  const useThinkTool = activeProvider !== "lmstudio";
  const surfaceOpts = {
    posture,
    policy: settings.vaultOpPolicy,
    useThinkTool,
  };
  const availability = ragService?.availability() ?? "no-backend";

  // Emission diverges by path. The direct Anthropic path emits the full stable
  // superset and holds it byte-identical across postures (Layer 1, keeps the prompt
  // cache warm); a runtime allow-list (allowedToolNames, enforced in the tool loop)
  // restricts what may actually be called, so posture/policy never shrink the emitted
  // block. semantic_search stays in the superset and reports unavailability at call
  // time. Local providers materialize exactly their allowed set; the shared filter
  // drops semantic_search when the backend is cold (so the two routes can't drift).
  let tools: CanonicalToolDefinition[] | undefined;
  let allowedToolNames: string[] | undefined;
  // The tools whose guidance the tail describes: what the model may actually use this
  // turn (the allowed subset on cloud, the emitted lean set on local).
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

  // Build tool guidance from guidanceTools so the tail accurately reflects what the
  // model may use (e.g. no semantic_search when the RAG index is not ready, and only
  // the permitted writes). Each body is kept separator-free for the tail; the local
  // path re-adds the leading "\n\n" to preserve its bytes.
  const activeVaultTools = guidanceTools.filter((t) => VAULT_TOOL_NAMES.has(t.name));
  const vaultGuidanceBody = useVaultTools ? buildVaultToolSystemPrompt(activeVaultTools) : "";
  const vaultGuidance = useVaultTools ? "\n\n" + vaultGuidanceBody : "";
  const activeEditTools = guidanceTools.filter((t) => EDIT_TOOL_NAMES.has(t.name));
  const editGuidanceBody = activeEditTools.length > 0 ? buildEditToolSystemPrompt(activeEditTools) : "";
  const editGuidance = activeEditTools.length > 0 ? "\n\n" + editGuidanceBody : "";
  const activeVaultOpTools = guidanceTools.filter((t) => VAULT_OPS_TOOL_NAMES.has(t.name));
  const vaultOpGuidanceBody = activeVaultOpTools.length > 0
    ? buildVaultOpToolSystemPrompt(activeVaultOpTools)
    : "";
  const vaultOpGuidance = activeVaultOpTools.length > 0 ? "\n\n" + vaultOpGuidanceBody : "";
  // Non-agentic regex-edit format guidance (ambient editing without tools). The
  // SEARCH/REPLACE format the diff engine parses, taught only when no edit tools carry
  // it (agentic edits are described by editGuidance instead).
  const regexEditGuidanceBody = useRegexEditGuidance ? EDIT_SYSTEM_PROMPT : "";
  const regexEditGuidance = useRegexEditGuidance ? "\n\n" + regexEditGuidanceBody : "";

  const finalSystemPrompt = disableBuiltinSystemPrompts
    ? profileSystemPrompt
    : systemPrompt + groundingNote + vaultGuidance + editGuidance + vaultOpGuidance + regexEditGuidance;

  // Layer 1 (prompt-cache design §6.1.2): on the billed paths that have a tail
  // mechanism, hold the cached `system` block invariant (profile prompt only) and
  // carry the per-turn wording + tool guidance in the message tail. Local providers
  // (and disableBuiltinSystemPrompts) keep the full system prompt, byte-for-byte, with
  // no tail. The clients place modeTail in their own tail mechanism (ChatRequest.modeTail).
  const useModeTail =
    !disableBuiltinSystemPrompts &&
    (activeProvider === "anthropic" || isClaudeCode);
  const { systemPrompt: outSystemPrompt, modeTail } = splitSystemForTail({
    useModeTail,
    fullSystemPrompt: finalSystemPrompt,
    cachedSystemPrompt: profileSystemPrompt,
    tailParts: [
      basePrefix,
      groundingNoteBody,
      vaultGuidanceBody,
      editGuidanceBody,
      vaultOpGuidanceBody,
      regexEditGuidanceBody,
    ],
  });

  return {
    systemPrompt: outSystemPrompt,
    ...(modeTail ? { modeTail } : {}),
    documentContext: null,
    ragContext,
    rewrittenQuery,
    messages,
    tools,
    ...(allowedToolNames ? { allowedToolNames } : {}),
  };
}

/**
 * Layer 1 decomposition of the system prompt into an invariant cached block and a
 * per-turn tail (prompt-cache design §6.1.2).
 *
 * When `useModeTail` is false (local providers, or built-in prompts disabled),
 * returns the full system prompt unchanged with no tail. When true, the cached
 * `system` becomes the profile prompt only and the per-turn pieces (`tailParts`, in
 * render order) are joined into `modeTail`. An all-empty tail yields
 * `modeTail: undefined` so callers never emit an empty block.
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

import type {
  ApprovalPosture,
  AssistantReplayEvidence,
  AssistantToolCallItem,
  AssistantTurnRecord,
  ConversationMessage,
  PluginSettings,
  ProviderOption,
  ProviderTurnCapabilities,
} from "../../shared/types";
import type { ChatRequest, ChatTurn, RagContextBlock, ToolSearchConfig } from "../../shared/chatRequest";
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
import { MEMORY_TOOL_NAMES } from "../../tools/memory/definition";
import { buildMemoryToolSystemPrompt } from "../../tools/memory/systemPrompt";
import { ASK_TOOL_NAMES } from "../../tools/ask/definition";
import { buildAskUserSystemPrompt } from "../../tools/ask/systemPrompt";
import {
  anthropicLayer2ToolSet,
  anthropicNonDeferredToolNames,
  cloudAllowedToolNames,
  cloudAllowedToolSet,
  cloudStableToolSet,
  resolveLocalToolSet,
} from "../../tools/toolSurface";
import { writesPermitted } from "../../vault-ops/gateway";
import {
  formatAgenticReplayLines,
  formatAskGuidanceReplayLines,
  INTERRUPTED_REPLAY_MARKER,
} from "../../tools/resultDigest";
import { formatAskGuidanceDigest } from "../../tools/ask/result";
import type { CanonicalToolDefinition } from "../../tools/types";
import type { App } from "obsidian";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";
import { editProposalsOf } from "../conversation/conversationUtils";
import type { RagService } from "../../rag";
import type { MemoryService } from "../../memory/MemoryService";
import type { ChatClient } from "../../api/chatClient";
import { rewriteQueryForRetrieval } from "../../rag/queryRewriter";
import type { EditProposal } from "../../editing/editTypes";
import {
  assistantDisplayText,
  assistantRawReplayText,
  getActiveAssistantRevision,
} from "../conversation/assistantRevisions";
import {
  INTERRUPTED_TOOL_RESULT_TEXT,
  toolFactText,
} from "../turns/assistantTurnProjections";
import {
  validateAssistantTurn,
  validateProviderReplayCapsule,
} from "../turns/assistantTurnValidation";
import { PROVIDER_DESCRIPTORS } from "../../providers/descriptors";

/**
 * Layer-2 tail note (ADR-0009): on the direct anthropic path with tool search, the read
 * tail and every write defer behind the search entry, so the model must search to load a
 * deferred tool's schema before calling it. Carried in the uncached modeTail (not the
 * cached prefix), so it does not affect the 4096-token cacheable-prefix floor.
 */
const TOOL_SEARCH_TAIL_NOTE =
  "Additional read, edit, and vault-op tools are available via tool search. " +
  "Use the tool-search tool to locate a tool by name or capability before calling it.";

export interface PrepareMessagesOptions {
  app: App;
  store: ChatSessionStore;
  settings: PluginSettings;
  /** Session approval posture, the cloud surface's replacement for the plan/chat/edit mode (section 6.3). */
  posture: ApprovalPosture;
  ragService?: RagService;
  memoryService: MemoryService;
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
  /** When true, built-in guidance is omitted; the profile and enabled memory index remain. */
  disableBuiltinSystemPrompts?: boolean;
  /**
   * Whether Anthropic prompt caching is enabled for this turn (the active profile's
   * `anthropicCacheSettings.enabled`). The sole Layer-2 enablement gate: tool search
   * rides the cache toggle on the direct `anthropic` agentic path (ADR-0009, no new user
   * setting). False / absent keeps the Layer-1 emission.
   */
  anthropicCacheEnabled?: boolean;
  /**
   * Abort signal armed by the caller before this awaited prep runs, so Stop cancels the
   * pre-stream RAG query rewrite (an LLM call) and retrieval instead of being a no-op
   * until streaming begins. An interrupted prep simply yields no retrieved context.
   */
  signal?: AbortSignal;
  /** Message omitted from provider history while an ephemeral regeneration draft streams. */
  excludeMessageId?: string;
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
    memoryService,
    activeProvider,
    modelCapabilities,
    chatClient,
    completionModelId,
    profileSystemPrompt = "",
    disableBuiltinSystemPrompts = false,
    supportsVision = false,
    anthropicCacheEnabled = false,
    signal,
    excludeMessageId,
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

  // Ambient editing (prompt-cache design section 6.3): with the plan/chat/edit modes gone, one
  // unified system prefix frames every turn. A non-agentic turn (no tools) still edits,
  // via SEARCH/REPLACE blocks the diff engine parses, so it carries the regex-edit format
  // guidance whenever editing is permitted but no tools carry it.
  const editsPermitted = writesPermitted(settings.vaultOpPolicy, posture);
  const useRegexEditGuidance = !useVaultTools && !claudeCodeRetrievesViaMcp && editsPermitted;

  const basePrefix = settings.systemPromptPrefix;
  const memoryIndex = settings.memoriesEnabled
    ? memoryService.getPinnedIndex(store.getActiveConversationId())
    : "";
  const cachedSystemPrompt = [profileSystemPrompt, memoryIndex].filter(Boolean).join("\n\n");
  const systemPrompt = [basePrefix, cachedSystemPrompt].filter(Boolean).join("\n\n");

  // The active note + extra notes (and their embedded images) are frozen into a
  // point-in-time snapshot bound to the user turn at send time (snapshotNoteAttachments),
  // so they ride message.attachments and stay cache-stable. There is no live re-read of
  // the active document here, the model reads current content via tools when it edits
  // (the section 10/section 13 cache-coupling anti-pattern is gone).
  const activeFilePath = app.workspace.getActiveFile()?.path;

  const historyProjection = projectRequestHistoryTurns(
    store
      .getSnapshot()
      .messageHistory
      .filter((message) => message.id !== excludeMessageId),
    supportsVision,
    activeProvider,
  );
  const messages = historyProjection.turns;

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
          signal,
        );
        if (retrievalQuery !== lastUserMessage.content) {
          rewrittenQuery = retrievalQuery;
        }
      }
      // Pre-injection is best-effort: if the embedding backend is unreachable,
      // retrieve() throws. Degrade silently to no context here, the in-loop
      // semantic_search tool is the surface that reports the failure to the model.
      // If Stop was pressed during the rewrite above, skip retrieval entirely so an
      // interrupted prep yields no context rather than firing an embedding request.
      if (!signal?.aborted) {
        try {
          ragContext = await ragService.retrieve(retrievalQuery, activeFilePath);
        } catch {
          ragContext = null;
        }
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
  // one source (prompt-cache design section 6.1.1/section 6.1.4/section 6.1.5).
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
    memoriesEnabled: settings.memoriesEnabled,
  };
  const availability = ragService?.availability() ?? "no-backend";

  // Layer 2 enablement (ADR-0009, settled): ride the Anthropic cache toggle. Tool search
  // defers the long tail only on the direct anthropic agentic path when caching is on, with
  // no new user setting. This is the single gate, so disabling Layer 2 (e.g. if the
  // 4096-token cacheable-prefix floor measurement fails) is a one-line change here.
  const useToolSearch = activeProvider === "anthropic" && useVaultTools && anthropicCacheEnabled;

  // Emission diverges by path. The direct Anthropic path emits a posture-invariant block
  // (Layer 1: the full stable superset; Layer 2: the non-deferred core + a deferred tail
  // behind the tool-search entry) and keeps the prompt cache warm; a runtime allow-list
  // (allowedToolNames, enforced in the tool loop) restricts what may actually be called, so
  // posture/policy never shrink the emitted block. semantic_search stays in the superset and
  // reports unavailability at call time. Local providers materialize exactly their allowed
  // set; the shared filter drops semantic_search when the backend is cold (so the two routes
  // can't drift).
  let tools: CanonicalToolDefinition[] | undefined;
  let allowedToolNames: string[] | undefined;
  let toolSearch: ToolSearchConfig | undefined;
  // The tools whose guidance the tail describes: what the model may actually use this
  // turn (the allowed subset on cloud, the emitted lean set on local).
  let guidanceTools: CanonicalToolDefinition[] = [];
  if (useVaultTools) {
    if (activeProvider === "anthropic") {
      // The runtime allow-list and the tail guidance are identical on both layers; only the
      // emitted `tools` block (and the toolSearch flag) differ.
      allowedToolNames = cloudAllowedToolNames(surfaceOpts);
      guidanceTools = filterSemanticSearchByAvailability(cloudAllowedToolSet(surfaceOpts), availability);
      if (useToolSearch) {
        // Layer 2: a small non-deferred core (core reads + think) stays in the cached
        // prefix; the read tail + every permitted write defers behind the native tool-search
        // entry. Deny-classed writes are already excluded by resolveWriteTools (inside
        // anthropicLayer2ToolSet), so they are not in the emitted tail = not discoverable,
        // closing the open seam at the discovery layer (ADR-0009).
        tools = filterSemanticSearchByAvailability(anthropicLayer2ToolSet(surfaceOpts), availability);
        toolSearch = {
          variant: "regex",
          nonDeferredToolNames: [
            ...anthropicNonDeferredToolNames(settings.memoriesEnabled),
          ],
        };
      } else {
        // Layer 1: the full stable superset, held byte-identical across postures.
        tools = cloudStableToolSet(settings.memoriesEnabled);
      }
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
  const activeMemoryTools = guidanceTools.filter((tool) =>
    MEMORY_TOOL_NAMES.has(tool.name),
  );
  const memoryGuidanceBody =
    activeMemoryTools.length > 0
      ? buildMemoryToolSystemPrompt(activeMemoryTools)
      : "";
  const memoryGuidance =
    activeMemoryTools.length > 0 ? "\n\n" + memoryGuidanceBody : "";
  const askGuidanceBody = buildAskUserSystemPrompt({
    askUserAvailable: guidanceTools.some((tool) => ASK_TOOL_NAMES.has(tool.name)),
    builtInPromptsEnabled: !disableBuiltinSystemPrompts,
  });
  const askGuidance = askGuidanceBody ? "\n\n" + askGuidanceBody : "";
  // Non-agentic regex-edit format guidance (ambient editing without tools). The
  // SEARCH/REPLACE format the diff engine parses, taught only when no edit tools carry
  // it (agentic edits are described by editGuidance instead).
  const regexEditGuidanceBody = useRegexEditGuidance ? EDIT_SYSTEM_PROMPT : "";
  const regexEditGuidance = useRegexEditGuidance ? "\n\n" + regexEditGuidanceBody : "";
  // Layer-2 tail note: tells the model the read tail + writes defer behind tool search, so
  // it must search to load a deferred tool's schema before calling it. Only when tool
  // search is active; rides the uncached tail, never the cached prefix.
  const toolSearchNoteBody = useToolSearch ? TOOL_SEARCH_TAIL_NOTE : "";
  const toolSearchNote = useToolSearch ? "\n\n" + toolSearchNoteBody : "";

  const finalSystemPrompt = disableBuiltinSystemPrompts
    ? cachedSystemPrompt
    : systemPrompt +
      groundingNote +
      vaultGuidance +
      editGuidance +
      vaultOpGuidance +
      memoryGuidance +
      askGuidance +
      toolSearchNote +
      regexEditGuidance;

  // Layer 1 (prompt-cache design section 6.1.2): on the billed paths that have a tail
  // mechanism, hold the cached `system` block invariant (profile prompt plus pinned
  // memory index) and
  // carry the per-turn wording + tool guidance in the message tail. Local providers
  // (and disableBuiltinSystemPrompts) keep the full system prompt, byte-for-byte, with
  // no tail. The clients place modeTail in their own tail mechanism (ChatRequest.modeTail).
  const useModeTail =
    !disableBuiltinSystemPrompts &&
    (activeProvider === "anthropic" || isClaudeCode);
  const { systemPrompt: outSystemPrompt, modeTail } = splitSystemForTail({
    useModeTail,
    fullSystemPrompt: finalSystemPrompt,
    cachedSystemPrompt,
    tailParts: [
      basePrefix,
      groundingNoteBody,
      vaultGuidanceBody,
      editGuidanceBody,
      vaultOpGuidanceBody,
      memoryGuidanceBody,
      askGuidanceBody,
      toolSearchNoteBody,
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
    replayEvidence: historyProjection.replayEvidence,
    tools,
    ...(allowedToolNames ? { allowedToolNames } : {}),
    ...(toolSearch ? { toolSearch } : {}),
  };
}

/**
 * Layer 1 decomposition of the system prompt into an invariant cached block and a
 * per-turn tail (prompt-cache design section 6.1.2).
 *
 * When `useModeTail` is false (local providers, or built-in prompts disabled),
 * returns the full system prompt unchanged with no tail. When true, the supplied
 * cached prompt stays in `system` and the per-turn pieces (`tailParts`, in render
 * order) are joined into `modeTail`. An all-empty tail yields
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

export interface RequestHistoryProjection {
  turns: ChatTurn[];
  replayEvidence: AssistantReplayEvidence;
}

interface MessageHistoryProjection {
  turns: ChatTurn[];
  tier: "structural" | "textual";
  loweredReason?: string;
  capabilities?: Partial<ProviderTurnCapabilities>;
}

/**
 * Maps one persisted message onto one or more request turns.
 *
 * User and legacy messages remain one-to-one. A selected chain-backed assistant
 * revision expands by provider segment, followed by one result turn per declared
 * call. A structural projection is accepted only when every declaration and
 * required result can be serialized without guessing.
 */
export function toHistoryTurns(
  message: ConversationMessage,
  supportsVision: boolean,
  provider?: ProviderOption,
): ChatTurn[] {
  return projectHistoryMessage(message, supportsVision, provider).turns;
}

/**
 * Project a complete persisted history and report the actual cold-replay tier.
 *
 * Provider descriptors are maxima. One legacy assistant or one invalid structural
 * record lowers the complete request to textual, even though other messages may
 * still retain their safe structural form internally.
 */
export function projectRequestHistoryTurns(
  messages: ConversationMessage[],
  supportsVision: boolean,
  provider?: ProviderOption,
): RequestHistoryProjection {
  const turns: ChatTurn[] = [];
  const projections: MessageHistoryProjection[] = [];

  for (const message of messages) {
    if (messageIsError(message)) {
      const guidanceLines = selectedAskGuidanceLines(message);
      if (guidanceLines.length > 0) {
        const projection: MessageHistoryProjection = {
          turns: [
            {
              role: "assistant",
              content: guidanceLines.join("\n\n"),
            },
          ],
          tier: "textual",
          loweredReason: "error_ask_guidance_textual_replay",
        };
        projections.push(projection);
        turns.push(...projection.turns);
      }
      continue;
    }
    const projection = projectHistoryMessage(
      message,
      supportsVision,
      provider,
    );
    projections.push(projection);
    turns.push(...projection.turns);
  }

  return {
    turns,
    replayEvidence: requestReplayEvidence(provider, projections),
  };
}

/** Array-only compatibility surface for callers that do not need diagnostics. */
export function toRequestHistoryTurns(
  messages: ConversationMessage[],
  supportsVision: boolean,
  provider?: ProviderOption,
): ChatTurn[] {
  return projectRequestHistoryTurns(messages, supportsVision, provider).turns;
}

function projectHistoryMessage(
  message: ConversationMessage,
  supportsVision: boolean,
  provider?: ProviderOption,
): MessageHistoryProjection {
  const attachments = message.attachments?.filter(
    (attachment) => attachment.type !== "image" || supportsVision,
  );
  if (message.role === "user") {
    return {
      turns: [
        {
          role: "user",
          content: message.content,
          ...(attachments?.length ? { attachments } : {}),
        },
      ],
      tier: provider === "claudecode" ? "textual" : "structural",
    };
  }

  const revision = getActiveAssistantRevision(message);
  if (revision?.kind === "turn") {
    if (provider === "claudecode") {
      return {
        turns: textualTurnRevision(message, revision.turn, true),
        tier: "textual",
        loweredReason: "claude_code_textual_cold_replay",
      };
    }
    const structuralFailure = structuralReplayFailure(revision.turn);
    if (structuralFailure === null) {
      return {
        turns: structuralTurnRevision(revision.turn, provider),
        tier: "structural",
      };
    }
    return {
      turns: textualTurnRevision(message, revision.turn, false),
      tier: "textual",
      loweredReason: structuralFailure,
      ...(structuralFailure === "tool_call_id_invalid"
        ? { capabilities: { toolCorrelation: "none" } }
        : {}),
    };
  }

  return {
    turns: [legacyTextualHistoryTurn(message, attachments, provider)],
    tier: "textual",
    loweredReason: "legacy_assistant_textual_replay",
    capabilities: {
      captureOrder: "text_only",
      toolCorrelation: "none",
      coldReplay: "textual",
    },
  };
}

function structuralReplayFailure(turn: AssistantTurnRecord): string | null {
  const validated = validateAssistantTurn(turn);
  if (!validated.ok) {
    if (validated.reason.code === "tool_call_id_invalid") {
      return "tool_call_id_invalid";
    }
    if (validated.reason.code === "replay_capsule_invalid") {
      return "replay_capsule_invalid";
    }
    return validated.reason.code;
  }
  for (const segment of turn.segments) {
    if (
      segment.replayCapsule !== undefined &&
      !validateProviderReplayCapsule(segment.replayCapsule).ok
    ) {
      return "replay_capsule_invalid";
    }
  }
  for (const item of turn.items) {
    if (item.type !== "tool_call") continue;
    if (item.toolCallId.trim().length === 0) return "tool_call_id_invalid";
    if (item.toolArgs === undefined) return "tool_arguments_invalid";
    if (
      (item.state === "completed" || item.state === "failed") &&
      item.resultRecord === undefined &&
      item.resultDigest === undefined
    ) {
      return "tool_result_evidence_missing";
    }
  }
  return null;
}

function structuralTurnRevision(
  turn: AssistantTurnRecord,
  provider: ProviderOption | undefined,
): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const segment of turn.segments) {
    const items = turn.items.filter((item) => item.segmentId === segment.id);
    if (items.length === 0) continue;
    turns.push({
      role: "assistant",
      content: null,
      assistantContent: items.map((item) =>
        item.type === "prose"
          ? { type: "prose", text: item.text }
          : {
              type: "tool_call",
              toolCallId: item.toolCallId,
              toolName: item.toolName,
              toolArguments: item.toolArguments,
              ...(item.toolArgs === undefined
                ? {}
                : { toolArgs: structuredClone(item.toolArgs) }),
            },
      ),
      ...(provider !== "anthropic" ||
      segment.replayCapsule === undefined
        ? {}
        : {
            providerReplayCapsule: structuredClone(
              segment.replayCapsule,
            ),
          }),
    });
    for (const item of items) {
      if (item.type !== "tool_call") continue;
      turns.push(structuralToolResult(item));
    }
  }
  return turns;
}

function structuralToolResult(item: AssistantToolCallItem): ChatTurn {
  if (
    item.state === "declared" ||
    item.state === "running" ||
    item.state === "interrupted"
  ) {
    return {
      role: "tool",
      content: INTERRUPTED_TOOL_RESULT_TEXT,
      toolCallId: item.toolCallId,
      toolResultIsError: true,
    };
  }
  const content = item.resultRecord ?? item.resultDigest;
  if (content === undefined) {
    throw new Error(
      `Tool call "${item.toolCallId}" has no bounded replay result.`,
    );
  }
  const isError = item.state === "failed" || item.isError === true;
  return {
    role: "tool",
    content,
    toolCallId: item.toolCallId,
    ...(isError ? { toolResultIsError: true } : {}),
  };
}

function textualTurnRevision(
  message: ConversationMessage,
  turn: AssistantTurnRecord,
  isClaudeCode: boolean,
): ChatTurn[] {
  const parts = turn.items.flatMap((item) => {
    if (item.type === "prose") return [item.text];
    if (item.askGuidance) return [formatAskGuidanceDigest(item.askGuidance)];
    return [toolFactText(item)];
  });
  if (
    isClaudeCode &&
    (turn.status === "interrupted" ||
      getActiveAssistantRevision(message)?.interrupted === true)
  ) {
    parts.push(INTERRUPTED_REPLAY_MARKER);
  }
  const content = parts.join("\n\n");
  const rawContent = assistantRawReplayText(message);
  return content || isClaudeCode
    ? [
        {
          role: "assistant",
          content,
          ...(isClaudeCode && content !== rawContent
            ? { rawContent }
            : {}),
        },
      ]
    : [];
}

function legacyTextualHistoryTurn(
  message: ConversationMessage,
  attachments: ConversationMessage["attachments"] | undefined,
  provider?: ProviderOption,
): ChatTurn {
  const rawContent = assistantRawReplayText(message);
  if (provider === "claudecode") {
    const replayed = annotateLegacyClaudeCodeReplay(message, rawContent);
    if (replayed !== rawContent) {
      return {
        role: "assistant",
        content: replayed,
        rawContent,
        ...(attachments?.length ? { attachments } : {}),
      };
    }
  }

  const annotated = editProposalsOf(message).length > 0;
  const baseContent = annotated
    ? formatEditMessageContent(message, assistantDisplayText(message))
    : assistantDisplayText(message);
  const content = appendReplayLines(
    baseContent,
    selectedAskGuidanceLines(message),
  );
  return {
    role: "assistant",
    content,
    ...(annotated && message.toolCalls?.length
      ? { rawContent }
      : {}),
    ...(attachments?.length ? { attachments } : {}),
  };
}

function annotateLegacyClaudeCodeReplay(
  message: ConversationMessage,
  rawContent: string,
): string {
  const parts: string[] = [];
  if (rawContent) parts.push(rawContent);
  const revision = getActiveAssistantRevision(message);
  const legacySteps =
    revision?.kind === "legacy"
      ? revision.legacySteps
      : message.agenticSteps;
  if (legacySteps?.length) {
    parts.push(...formatAgenticReplayLines(legacySteps));
  }
  if (revision?.interrupted ?? message.interrupted) {
    parts.push(INTERRUPTED_REPLAY_MARKER);
  }
  return parts.join("\n\n");
}

function selectedAskGuidanceLines(
  message: ConversationMessage,
): string[] {
  const revision = getActiveAssistantRevision(message);
  if (revision?.kind === "turn") {
    return revision.turn.items.flatMap((item) =>
      item.type === "tool_call" && item.askGuidance
        ? [formatAskGuidanceDigest(item.askGuidance)]
        : [],
    );
  }
  const steps =
    revision?.kind === "legacy"
      ? revision.legacySteps
      : message.agenticSteps;
  return formatAskGuidanceReplayLines(steps ?? []);
}

function messageIsError(message: ConversationMessage): boolean {
  if (message.role !== "assistant") return message.isError === true;
  return getActiveAssistantRevision(message)?.isError ?? message.isError ?? false;
}

function requestReplayEvidence(
  provider: ProviderOption | undefined,
  projections: MessageHistoryProjection[],
): AssistantReplayEvidence {
  if (!provider) {
    return {
      tier: "textual",
      capabilities: {
        captureOrder: "text_only",
        toolCorrelation: "none",
        coldReplay: "textual",
        nativeResume: false,
      },
      loweredReason: "provider_replay_capabilities_unavailable",
    };
  }
  const maximum = structuredClone(
    PROVIDER_DESCRIPTORS[provider].turnCapabilities,
  );
  const lowered = projections.filter(
    (projection) => projection.tier === "textual",
  );
  if (provider === "claudecode") {
    return {
      tier: "textual",
      capabilities: {
        ...maximum,
        coldReplay: "textual",
      },
      loweredReason: uniqueReasons(lowered) ||
        "claude_code_textual_cold_replay",
    };
  }
  if (lowered.length === 0) {
    return {
      tier: maximum.coldReplay,
      capabilities: maximum,
    };
  }
  const capabilities = lowered.reduce(
    (current, projection) => ({
      ...current,
      ...projection.capabilities,
      coldReplay: "textual" as const,
    }),
    { ...maximum, coldReplay: "textual" as const },
  );
  return {
    tier: "textual",
    capabilities,
    loweredReason: uniqueReasons(lowered),
  };
}

function uniqueReasons(projections: MessageHistoryProjection[]): string {
  return [
    ...new Set(
      projections.flatMap((projection) =>
        projection.loweredReason ? [projection.loweredReason] : [],
      ),
    ),
  ].join(",");
}

function appendReplayLines(content: string, lines: string[]): string {
  if (lines.length === 0) return content;
  return [content, ...lines].filter(Boolean).join("\n\n");
}

/**
 * Annotates an assistant message's edit blocks with their accept/reject
 * outcomes so the model knows which edits were applied.
 *
 * For regex-parsed messages: rawBlocks are found in the content string and
 * annotated inline. For tool-call messages: a summary is appended since the
 * content is pure prose with no embedded blocks.
 */
function formatEditMessageContent(
  message: ConversationMessage,
  selectedContent: string,
): string {
  const proposals = editProposalsOf(message);
  if (proposals.length === 0) return selectedContent;

  // Tool-call messages: content is pure prose, annotate with a per-file summary
  // across every edited file (ADR-0010).
  if (message.toolCalls && message.toolCalls.length > 0) {
    return formatToolCallEditHistory(selectedContent, proposals);
  }

  // Regex-parsed messages are single-file (the active document): annotate inline
  // SEARCH/REPLACE rawBlocks on the sole proposal.
  const editProposal = proposals[0];
  let content = selectedContent;
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
 * Builds history text for a tool-call-based edit message, across every edited file
 * (ADR-0010). Appends a per-hunk summary, each tagged with its file, so the model knows
 * what was accepted/rejected and where.
 */
function formatToolCallEditHistory(prose: string, proposals: EditProposal[]): string {
  const parts: string[] = [];
  if (prose) parts.push(prose);

  let acceptedCount = 0;
  let rejectedCount = 0;

  for (const proposal of proposals) {
    const file = proposal.targetFilePath.split("/").pop() ?? proposal.targetFilePath;
    for (const hunk of proposal.hunks) {
      const status = hunk.status === "accepted" ? "ACCEPTED" : "REJECTED";
      const search = hunk.resolvedEdit.editBlock.searchText;
      const preview = search.length > 80 ? search.slice(0, 80) + "..." : search;
      parts.push(`[Edit in ${file}: "${preview}", ${status}]`);

      if (hunk.status === "accepted") acceptedCount++;
      else rejectedCount++;
    }
  }

  const total = acceptedCount + rejectedCount;
  if (total > 0) {
    parts.push(`[Edit outcome: ${acceptedCount} accepted, ${rejectedCount} rejected out of ${total} proposed changes]`);
  }

  return parts.join("\n\n");
}

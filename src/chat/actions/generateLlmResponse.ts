import type { Component } from "obsidian";
import { Notice } from "obsidian";
import { buildSamplingParams } from "../finalization/buildSamplingParams";
import { resolveModelReasoning } from "../../providers/reasoningLevels";
import type WritingAssistantChat from "../../main";
import type { ChatClient } from "../../api/chatClient";
import { createAbortError } from "../../api/httpTransport";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";
import type { ChatTranscript } from "../messages/ChatTranscript";
import type {
  ApprovalPosture,
  AssistantReplayEvidence,
  AssistantTurnRecord,
  CompletionModel,
  ConversationMessage,
} from "../../shared/types";
import { writesPermitted } from "../../vault-ops/gateway";
import { getActiveProfile } from "../../shared/profileUtils";
import { makeMessage } from "../conversation/conversationUtils";
import { prepareApiMessages } from "../finalization/prepareApiMessages";
import { estimateTokenCount } from "../../shared/tokenEstimation";
import { StreamingRenderer } from "../streaming/StreamingRenderer";
import { EditStreamingRenderer } from "../streaming/EditStreamingRenderer";
import {
  finalizeResponse,
  finalizeAbortedResponse,
  insertLastResponse,
} from "../finalization/finalizeResponse";
import {
  buildRegexEditProposals,
  finalizeEditResponse,
} from "../finalization/finalizeEditResponse";
import { estimateCost } from "../../api/pricing";
import type { UsageResult } from "../../api/usageTypes";
import type { MessageUsage } from "../../shared/types";
import { runToolLoop } from "./toolLoop";
import type {
  MemoryToolContext,
  ToolExecutionContext,
  VaultOpToolContext,
  VaultToolContext,
} from "./toolLoop";
import { LiveVaultReview } from "./liveVaultReview";
import { AgenticTimeline } from "../messages/AgenticTimeline";
import { extractToolInput } from "../../tools/metadata";
import {
  captureStepFields,
  hasCompletedAskGuidance,
} from "../../tools/resultDigest";
import { CONTEXT_DANGER_THRESHOLD } from "../../constants";
import type { ComposerInteractionHostPort } from "../interactions/ComposerInteractionHost";
import { AskInteractionCoordinator } from "../interactions/AskInteractionCoordinator";
import { generateId } from "../../utils";
import { AssistantTurnBuilder } from "../turns/AssistantTurnBuilder";
import {
  createAssistantTurnMessage,
  createAssistantTurnRevision,
} from "../finalization/assistantTurnFinalization";
import { buildDirectProviderActionLedger } from "../finalization/directProviderActionLedger";
import { getActiveAssistantRevision } from "../conversation/assistantRevisions";
import {
  allVisibleProse,
  rawConcatenatedProse,
} from "../turns/assistantTurnProjections";
import { GENERATION_STOPPED_LABEL } from "../types";

/**
 * How to commit the completed generation to the store.
 * - "append": add a new assistant message (send / resume)
 * - "replace": replace an existing assistant message (regenerate)
 */
type FinalizationMode =
  | { kind: "append"; autoInsert?: boolean }
  | { kind: "replace"; oldMessage: ConversationMessage };

export interface LlmGenerationOptions {
  plugin: WritingAssistantChat;
  owner: Component;
  store: ChatSessionStore;
  transcript: ChatTranscript;
  activeModel: CompletionModel;
  client: ChatClient;
  interactionHost: ComposerInteractionHostPort;
  /** Session approval posture, the replacement for the plan/chat/edit mode (section 6.3). */
  posture: ApprovalPosture;
  finalization: FinalizationMode;
  setIsGenerating: (v: boolean) => void;
  setActiveAbortController: (c: AbortController | null) => void;
  onCalibrate?: (estimated: number, actual: number) => void;
  /** Flip the session to auto-apply; powers the edit review's "Accept all this session". */
  onEnterAutoApply?: () => void;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Unknown error";
}

function buildMessageUsage(modelId: string, usage: UsageResult): MessageUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheCreationInputTokens !== undefined && { cacheCreationInputTokens: usage.cacheCreationInputTokens }),
    ...(usage.cacheReadInputTokens !== undefined && { cacheReadInputTokens: usage.cacheReadInputTokens }),
    ...(usage.contextTokens !== undefined && { contextTokens: usage.contextTokens }),
    // Provider-reported cost wins over the price-table estimate (mirrors
    // finalizeResponse): Claude Code's aliases have no price-table entry at all.
    estimatedCostUsd: usage.costUsd ?? estimateCost(modelId, usage) ?? undefined,
  };
}

/**
 * The tokens actually occupying the context window for a request, for capacity
 * calibration. Cached prompt tokens are still context, so cache reads/writes
 * count; `inputTokens` alone is just the uncached remainder and collapses the
 * correction ratio toward zero on well-cached turns.
 */
function contextTokensOf(usage: UsageResult): number {
  return (
    usage.inputTokens + (usage.cacheCreationInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0)
  );
}

/**
 * Core generation pipeline shared by all entry points (send, resume, regenerate).
 *
 * Callers are responsible for mutating the store into the correct pre-generation
 * state (appending a user message, removing an old assistant message, etc.) before
 * calling this function. This function owns everything from context preparation
 * through streaming, finalization, and cleanup.
 */
export async function generateLlmResponse(options: LlmGenerationOptions): Promise<void> {
  const {
    plugin,
    owner,
    store,
    transcript,
    activeModel,
    client,
    interactionHost,
    posture,
    finalization,
    setIsGenerating,
    setActiveAbortController,
    onCalibrate,
    onEnterAutoApply,
  } = options;

  const activeProfile = getActiveProfile(plugin.settings, activeModel.provider);
  const directProvider = activeModel.provider !== "claudecode";
  const draftIdentity = {
    messageId: generateId(),
    revisionId: `revision-${generateId()}`,
    turnId: `turn-${generateId()}`,
    createdAt: Date.now(),
  };
  const turnBuilder = new AssistantTurnBuilder({
    turnId: draftIdentity.turnId,
  });
  let capturedTurn: AssistantTurnRecord | null = null;
  let capturedReplayEvidence: AssistantReplayEvidence | null = null;
  let capturedToolCorrelations: Record<
    string,
    "provider_id" | "plugin_id"
  > = {};

  // Ambient editing (prompt-cache design section 6.3): the edit pipeline (edit renderer, edit
  // review channel, finalizeEditResponse) is active whenever the session permits any
  // write. A read-only session is exactly a deny-all policy under the `ask` posture.
  const editsActive = writesPermitted(plugin.settings.vaultOpPolicy, posture);
  const activeFilePath = plugin.app.workspace.getActiveFile()?.path;

  // Arm the abort controller BEFORE the awaited prep (RAG query rewrite + retrieval) so
  // Stop cancels during context preparation instead of being a visible no-op until the
  // first delta. The liveReview cancel listener is attached later, once liveReview exists.
  const abortController = new AbortController();
  setActiveAbortController(abortController);
  const askCoordinator = new AskInteractionCoordinator(
    interactionHost,
    abortController.signal,
  );

  let apiMessages;
  try {
    apiMessages = await prepareApiMessages({
      app: plugin.app,
      store,
      settings: plugin.settings,
      posture,
      signal: abortController.signal,
      ragService: plugin.services.ragService,
      memoryService: plugin.services.memoryService,
      activeProvider: activeModel.provider,
      modelCapabilities: {
        trainedForToolUse:
          activeModel.trainedForToolUse ??
          plugin.services.modelAvailability.getTrainedForToolUse(activeModel.modelId),
      },
      chatClient: client,
      completionModelId: activeModel.modelId,
      profileSystemPrompt: activeProfile.systemPrompt,
      disableBuiltinSystemPrompts: activeProfile.disableBuiltinSystemPrompts,
      // Layer-2 enablement rides this same toggle (ADR-0009): tool search activates on the
      // direct anthropic agentic path only when caching is on. The cache settings themselves
      // are attached just below; prepareApiMessages needs the flag up front to choose the
      // tool emission.
      anthropicCacheEnabled: activeProfile.anthropicCacheSettings.enabled,
      // Unknown vision capability is treated as allow-the-attempt: keep image attachments in
      // the request for an unprobed model rather than stripping them (matches the attach gate).
      supportsVision: activeModel.vision
        ?? plugin.services.modelAvailability.getVision(activeModel.modelId)
        ?? true,
      ...(finalization.kind === "replace"
        ? { excludeMessageId: finalization.oldMessage.id }
        : {}),
    });
  } catch (error) {
    askCoordinator.destroy();
    setActiveAbortController(null);
    await store.persistActiveConversation();
    setIsGenerating(false);
    throw error;
  }

  const ragSources = apiMessages.ragContext?.map(
    ({ filePath, headingPath, score, content, graphContext }) => ({
      filePath,
      headingPath,
      score,
      content,
      graphContext,
    }),
  );
  const { rewrittenQuery } = apiMessages;

  if (activeProfile.anthropicCacheSettings.enabled) {
    apiMessages.anthropicCacheSettings = activeProfile.anthropicCacheSettings;
  }

  await store.persistActiveConversation();

  const contextWindow = plugin.services.modelAvailability.resolveContextWindow(activeModel);
  if (contextWindow) {
    const estimatedTokens = estimateTokenCount(apiMessages);
    if (estimatedTokens / contextWindow >= CONTEXT_DANGER_THRESHOLD) {
      const pct = Math.round((estimatedTokens / contextWindow) * 100);
      new Notice(`Context is ~${pct}% full. The model may truncate older messages.`);
    }
  }

  const assistantBubble = transcript.createBubble("assistant");
  assistantBubble.bodyEl.addClass("is-streaming");

  // useToolMode: the edit renderer shows a tool-call UI overlay (not for vault-only tool use)
  const useToolMode = editsActive && !!apiMessages.tools?.length;
  const renderer = editsActive
    ? new EditStreamingRenderer(assistantBubble, transcript, { useToolMode })
    : new StreamingRenderer(assistantBubble, transcript);

  // Two distinct agentic shapes feed the timeline:
  //  - pluginAgentic: the plugin runs its own tool loop (tools attached to the
  //    request). Deltas are buffered per round and only the final round reaches
  //    the bubble; the timeline is driven by the loop's callbacks, created eagerly.
  //  - claudeCodeAgentic: Claude Code runs its loop internally over MCP. Its text
  //    streams straight to the bubble (no buffering) and the timeline is driven by
  //    the service's tool-lifecycle events, created lazily on the first tool call
  //    so tool-less turns (the common case) don't render an empty timeline.
  const pluginAgentic = !!apiMessages.tools?.length;
  const claudeCodeAgentic =
    activeModel.provider === "claudecode" && plugin.settings.agenticMode;
  // pluginTimeline (const, so callbacks narrow cleanly) is the eager instance the
  // tool-loop writes to. `timeline` is whatever exists at finalization: starts as
  // pluginTimeline, filled lazily on the Claude Code path at its first MCP tool call.
  const pluginTimeline = pluginAgentic
    ? new AgenticTimeline(assistantBubble.timelineEl)
    : null;
  let timeline: AgenticTimeline | null = pluginTimeline;

  const vaultToolContext: VaultToolContext = {
    app: plugin.app,
    ragService: plugin.services.ragService,
    // The active note rides as a frozen attachment; the model reads current content
    // via tools, so the active file is just the current pane's file (RAG exclusion).
    activeFilePath,
  };

  const editToolContext: ToolExecutionContext | undefined =
    editsActive
      ? { app: plugin.app, filePath: activeFilePath ?? "" }
      : undefined;
  const memoryToolContext: MemoryToolContext | undefined =
    plugin.settings.memoriesEnabled
      ? {
          memoryService: plugin.services.memoryService,
          getMemories: () => plugin.settings.memories,
          saveSettings: () => plugin.saveSettings(),
        }
      : undefined;

  // The in-loop review coordinator: owns the live vault-op proposal, mounts the
  // review on the streaming timeline, applies auto ops, and suspends the loop on
  // ask-gated ops until the user decides (in-loop-tool-approval-blocking-flow). In
  // when editing is active it also owns the edit channel, folding the live diff onto
  // the timeline step like vault ops (ADR-0018).
  const liveReview = new LiveVaultReview({
    app: plugin.app,
    timelineEl: assistantBubble.timelineEl,
    policy: plugin.settings.vaultOpPolicy,
    posture,
    ...(editsActive && {
      edit: {
        inlineDiff: plugin.inlineDiff,
        resolveOptions: {
          contextLines: plugin.settings.diffContextLines,
          minConfidence: plugin.settings.diffMinMatchConfidence,
        },
        ...(onEnterAutoApply && { onEnterAutoApply }),
      },
    }),
    ...(memoryToolContext && { memory: memoryToolContext }),
  });

  // Vault ops operate on arbitrary paths, so they need only the app + the live
  // review; the coordinator rebuilds the pending overlay per round.
  const vaultOpToolContext: VaultOpToolContext = { app: plugin.app, liveReview };

  // Abort (stop button, or a new user turn superseding this one) must resolve any
  // op parked on the user, or a suspended loop would hang forever on the await. The
  // controller itself was armed before prepareApiMessages so Stop also cancels prep.
  abortController.signal.addEventListener("abort", () => liveReview.cancelPending());

  const editRenderer = renderer instanceof EditStreamingRenderer ? renderer : null;
  const chatRenderer = renderer instanceof StreamingRenderer ? renderer : null;
  const persistDirectTurn = async (input: {
    turn: AssistantTurnRecord;
    replayEvidence: AssistantReplayEvidence;
    toolCorrelations: Record<string, "provider_id" | "plugin_id">;
    usage?: UsageResult | null;
    isError?: boolean;
    interrupted?: boolean;
    errorMessage?: string;
    editProposals?: ReturnType<LiveVaultReview["getEditProposals"]>;
    parsedEditPlacement?: { itemId: string; actionRef: string };
  }): Promise<boolean> => {
    const actionLedger = buildDirectProviderActionLedger({
      revisionId: draftIdentity.revisionId,
      turn: input.turn,
      toolCorrelations: input.toolCorrelations,
      editProposals:
        input.editProposals ?? liveReview.getEditProposals(),
      appliedEditRecords: liveReview.getEditAppliedRecords(),
      vaultOpProposal: liveReview.getProposal() ?? undefined,
      appliedVaultOpRecord: liveReview.getAppliedRecord() ?? undefined,
      memoryProposals: liveReview.getMemoryProposals(),
      parsedEditPlacement: input.parsedEditPlacement,
      createEventId: () => `event-${generateId()}`,
      createdAt: draftIdentity.createdAt,
    });
    const parentRevision =
      finalization.kind === "replace"
        ? getActiveAssistantRevision(finalization.oldMessage)
        : null;
    const revision = createAssistantTurnRevision({
      revisionId: draftIdentity.revisionId,
      origin:
        finalization.kind === "replace"
          ? "regenerated"
          : "generated",
      ...(parentRevision
        ? { parentRevisionId: parentRevision.revisionId }
        : {}),
      createdAt: draftIdentity.createdAt,
      provider: activeModel.provider,
      modelId: activeModel.modelId,
      turn: input.turn,
      replayEvidence: input.replayEvidence,
      ...(input.usage
        ? { usage: buildMessageUsage(activeModel.modelId, input.usage) }
        : {}),
      ...(ragSources ? { ragSources } : {}),
      ...(rewrittenQuery ? { rewrittenQuery } : {}),
      ...(input.isError ? { isError: true } : {}),
      ...(input.interrupted ? { interrupted: true } : {}),
      ...(input.errorMessage
        ? { errorMessage: input.errorMessage }
        : {}),
    });
    const response = allVisibleProse(input.turn);
    if (finalization.kind === "replace") {
      if (input.turn.items.length === 0) return false;
      const committed = store.commitRevisionReplacement(
        finalization.oldMessage.id,
        revision,
        (_actionRef, _targetId, index) => ({
          eventId: `event-${generateId()}-${index}`,
          createdAt: Math.max(Date.now(), draftIdentity.createdAt),
        }),
        actionLedger,
      );
      if (!committed) {
        throw new Error("Could not commit the regenerated assistant revision.");
      }
      transcript.registerBubble(finalization.oldMessage.id, assistantBubble);
    } else {
      const assistantMessage = createAssistantTurnMessage({
        messageId: draftIdentity.messageId,
        revision,
        actionLedger,
      });
      store.appendMessage(assistantMessage);
      transcript.registerBubble(assistantMessage.id, assistantBubble);
    }
    store.setLastAssistantResponse(response);
    if (response) {
      await transcript.renderBubbleContent(assistantBubble, response);
    } else {
      transcript.renderPlainTextContent(assistantBubble, "(no response)");
    }
    if (
      finalization.kind === "append" &&
      finalization.autoInsert &&
      response
    ) {
      await insertLastResponse(plugin, response);
    }
    return true;
  };

  try {

    // One unified agentic round budget now that the modes are gone (the old edit-only
    // cap keyed off the live document, which no longer exists). The per-turn
    // identical-call guard is the primary spin control; this is the high backstop.
    const maxRounds = plugin.settings.maxToolRounds;

    // Only the plugin-owned tool loop buffers deltas; Claude Code streams live.
    const agenticMode = pluginAgentic;

    // Claude Code's tools fire inside its subprocess over MCP, not through the
    // tool loop, route those lifecycle events into the same timeline, created on
    // first use so tool-less turns stay clean.
    if (claudeCodeAgentic) {
      plugin.services.claudeCode.setAskUserResponder(
        askCoordinator,
        abortController.signal,
      );
      plugin.services.claudeCode.setLiveReview(liveReview);
      plugin.services.claudeCode.setToolListener((event) => {
        const tl = timeline ?? (timeline = new AgenticTimeline(assistantBubble.timelineEl));
        if (event.phase === "start") {
          // Pass the id so the in-loop vault review binds to this step while it is
          // still pending (avoids a stray synthetic row, see addPendingToolCall).
          tl.addPendingToolCall(event.toolName, event.toolCallId);
        } else {
          tl.addStep({
            type: "tool_call",
            round: 0,
            toolName: event.toolName,
            toolInput: extractToolInput({ name: event.toolName, arguments: event.args }),
            toolArgs: event.args,
            // Same id the vault op carries (minted in ClaudeCodeService.callTool),
            // so the review binds approve/decline to this step.
            toolCallId: event.toolCallId,
            ...(event.askStatus && { askStatus: event.askStatus }),
            // A failed call (e.g. an edit no-match, which never reaches the review
            // overlay) flags its step red and reveals the error returned to the model.
            ...(event.isError && { isError: true, errorContent: event.content }),
            // Phase-2 replay capture: disposition + discovery digest + bounded record.
            // This is the Claude Code choke point (the MCP loop is otherwise opaque to
            // the plugin transcript); the plugin tool loop is the sibling choke point.
            ...captureStepFields(event.toolName, event.args, {
              content: event.content,
              isError: event.isError,
              disposition: event.disposition,
            }),
          });
        }
      });
    }

    const loopResult = await runToolLoop(
      client,
      apiMessages,
      activeModel.modelId,
      activeModel.provider,
      buildSamplingParams(
        activeProfile,
        resolveModelReasoning(
          plugin.settings.reasoningByModelKey,
          activeModel,
          plugin.services.modelAvailability,
        ),
      ),
      abortController.signal,
      {
        onDelta: (delta) => renderer.appendDelta(delta),
        onToolStatus: (name) => {
          if (editRenderer) editRenderer.showToolStatus(name);
          else chatRenderer?.showToolStatus(name);
        },
        onNewRound: () => {
          if (editRenderer) editRenderer.beginNewRound();
          else chatRenderer?.beginNewRound();
        },
        // These callbacks fire from the plugin's own tool loop only. For Claude
        // Code the loop runs a single pass with no tool calls, and the timeline is
        // driven by the MCP listener below, so they stay unset there to avoid
        // mirroring the streamed answer text into the timeline as reasoning.
        onToolDeclared: pluginTimeline
          ? (name) => pluginTimeline.addPendingToolCall(name)
          : undefined,
        onStepRecorded: pluginTimeline ? (step) => pluginTimeline.addStep(step) : undefined,
        onStepResult: pluginTimeline ? (id, result) => pluginTimeline.setStepResult(id, result) : undefined,
        onCalibrate: onCalibrate
          ? (request, usage) => {
              // A provider that reports its context size directly (Claude Code)
              // doesn't use ratio correction, the ring anchors on the persisted
              // per-message contextTokens instead. Its huge fixed harness
              // overhead over a small transcript would poison the ratio (~65x).
              if (usage.contextTokens !== undefined) return;
              const estimated = estimateTokenCount(request);
              onCalibrate(estimated, contextTokensOf(usage));
            }
          : undefined,
      },
      maxRounds,
      agenticMode,
      vaultToolContext,
      editToolContext,
      vaultOpToolContext,
      memoryToolContext,
      askCoordinator,
      turnBuilder,
      (toolCallId) =>
        `action-${draftIdentity.revisionId}-${toolCallId}`,
    );
    const {
      writeToolCalls,
      usage: finalUsage,
      writeStopReason,
      turn,
      replayEvidence,
      toolCorrelations,
    } = loopResult;
    capturedTurn = turn;
    capturedReplayEvidence = replayEvidence;
    capturedToolCorrelations = toolCorrelations;
    if (abortController.signal.aborted) throw createAbortError();

    await renderer.flush();
    assistantBubble.bodyEl.removeClass("is-streaming");
    timeline?.finalize();

    // Claude Code reports its own context window per turn (its catalog aliases
    // carry no static size); record it so the capacity ring's fallback lookup
    // resolves from the next recalculation on.
    if (finalUsage?.contextWindow) {
      plugin.services.modelAvailability.reportContextWindow(
        activeModel.modelId,
        finalUsage.contextWindow,
      );
    }

    const agenticSteps = timeline?.getSteps();

    // Claude Code runs its tools internally, so its write proposals (edits and
    // vault ops) arrive via the MCP server (collected on the service) rather than
    // through the tool loop. Both channels surface to the same finalizer, which
    // partitions them back apart by tool name.
    const isClaudeCode = activeModel.provider === "claudecode";
    const ccWriteToolCalls = isClaudeCode
      ? [
          ...plugin.services.claudeCode.takeCollectedEdits(),
          ...plugin.services.claudeCode.takeCollectedVaultOps(),
        ]
      : [];
    const effectiveWriteToolCalls = ccWriteToolCalls.length > 0 ? ccWriteToolCalls : writeToolCalls;

    if (directProvider) {
      let persistedTurn = turn;
      let regexEditProposals:
        | ReturnType<LiveVaultReview["getEditProposals"]>
        | undefined;
      let parsedEditPlacement:
        | { itemId: string; actionRef: string }
        | undefined;
      if (editsActive && !pluginAgentic) {
        regexEditProposals = await buildRegexEditProposals(
          plugin.app,
          plugin,
          rawConcatenatedProse(turn),
        );
        if (regexEditProposals.length > 0) {
          const actionRef =
            `action-${draftIdentity.revisionId}-parsed-edit`;
          const anchored = anchorParsedEditTurn(turn, actionRef);
          persistedTurn = anchored.turn;
          parsedEditPlacement = {
            itemId: anchored.itemId,
            actionRef,
          };
        }
      }
      await persistDirectTurn({
        turn: persistedTurn,
        replayEvidence,
        toolCorrelations,
        usage: finalUsage,
        editProposals: regexEditProposals,
        parsedEditPlacement,
      });
    } else if (editsActive && renderer instanceof EditStreamingRenderer) {
      // Drop the transient in-loop edit panel so it can't double up with the
      // durable one finalize renders into the message body.
      liveReview.detachEditPanel();
      await finalizeEditResponse({
        app: plugin.app,
        owner,
        store,
        transcript,
        bubble: assistantBubble,
        renderer,
        plugin,
        modelId: activeModel.modelId,
        provider: activeModel.provider,
        usage: finalUsage,
        toolCalls: effectiveWriteToolCalls,
        agenticSteps,
        stoppedForMaxTokens: writeStopReason === "max_tokens",
        posture,
        prebuiltVaultOpProposal: liveReview.getProposal() ?? undefined,
        prebuiltVaultOpRecord: liveReview.getAppliedRecord() ?? undefined,
        prebuiltEditProposals: liveReview.getEditProposals(),
        prebuiltEditRecords: liveReview.getEditAppliedRecords(),
        ...(onEnterAutoApply && { onEnterAutoApply }),
      });
    } else if (finalization.kind === "replace") {
      const response = chatRenderer?.getCurrentRoundResponse() ?? "";
      if (response || hasCompletedAskGuidance(agenticSteps)) {
        store.finalizeRegeneration(finalization.oldMessage, response, {
          modelId: activeModel.modelId,
          provider: activeModel.provider,
          ...(finalUsage && { usage: buildMessageUsage(activeModel.modelId, finalUsage) }),
          ragSources,
          rewrittenQuery,
          ...(agenticSteps?.length && { agenticSteps }),
        });
        transcript.registerBubble(finalization.oldMessage.id, assistantBubble);
      } else {
        transcript.renderPlainTextContent(assistantBubble, "(no response)");
      }
    } else {
      await finalizeResponse(
        store,
        transcript,
        assistantBubble,
        renderer as StreamingRenderer,
        finalization.autoInsert ?? false,
        plugin,
        activeModel.modelId,
        activeModel.provider,
        finalUsage,
        ragSources,
        rewrittenQuery,
        agenticSteps,
      );
    }
  } catch (error) {
    await renderer.flush();
    assistantBubble.bodyEl.removeClass("is-streaming");
    timeline?.finalize();

    if (isAbortError(error) || abortController.signal.aborted) {
      const partialSteps = timeline?.getSteps();
      if (directProvider) {
        const interruptedTurn =
          capturedTurn ??
          finishDirectTurn(turnBuilder, "interrupted", "Generation stopped.");
        await persistDirectTurn({
          turn: interruptedTurn,
          replayEvidence:
            capturedReplayEvidence ??
            directFallbackReplayEvidence("stream_interrupted"),
          toolCorrelations:
            Object.keys(capturedToolCorrelations).length > 0
              ? capturedToolCorrelations
              : inferDirectToolCorrelations(interruptedTurn),
          interrupted: interruptedTurn.status === "interrupted",
        });
        if (interruptedTurn.items.length === 0) {
          transcript.renderPlainTextContent(
            assistantBubble,
            GENERATION_STOPPED_LABEL,
          );
          assistantBubble.bodyEl.addClass("is-muted");
        }
      } else if (editsActive && renderer instanceof EditStreamingRenderer) {
        liveReview.detachEditPanel();
        await finalizeEditResponse({
          app: plugin.app,
          owner,
          store,
          transcript,
          bubble: assistantBubble,
          renderer,
          plugin,
          modelId: activeModel.modelId,
          provider: activeModel.provider,
          agenticSteps: partialSteps,
          interrupted: true,
          posture,
          prebuiltVaultOpProposal: liveReview.getProposal() ?? undefined,
          prebuiltVaultOpRecord: liveReview.getAppliedRecord() ?? undefined,
          prebuiltEditProposals: liveReview.getEditProposals(),
          prebuiltEditRecords: liveReview.getEditAppliedRecords(),
          ...(onEnterAutoApply && { onEnterAutoApply }),
        });
      } else if (finalization.kind === "replace") {
        const response = chatRenderer?.getCurrentRoundResponse() ?? "";
        if (response || hasCompletedAskGuidance(partialSteps)) {
          store.finalizeRegeneration(finalization.oldMessage, response, {
            modelId: activeModel.modelId,
            provider: activeModel.provider,
            ...(partialSteps?.length && { agenticSteps: partialSteps }),
            interrupted: true,
          });
          transcript.registerBubble(finalization.oldMessage.id, assistantBubble);
        } else {
          // Stopped before any text arrived. regenerateMessage popped the
          // original message up front (removeLastMessage), so unless we put it
          // back here the original content AND its whole version history are
          // dropped by the finally-persist below. Restore it exactly (no spurious
          // version) and show it back in the bubble. This is the abort-side
          // counterpart to the error branch's restore.
          store.restoreRegeneration(finalization.oldMessage);
          transcript.registerBubble(finalization.oldMessage.id, assistantBubble);
          await transcript.renderBubbleContent(assistantBubble, finalization.oldMessage.content);
        }
      } else {
        await finalizeAbortedResponse(
          store,
          transcript,
          assistantBubble,
          renderer as StreamingRenderer,
          activeModel.modelId,
          activeModel.provider,
          ragSources,
          rewrittenQuery,
          partialSteps,
        );
      }
    } else {
      const errorText = `Error: ${getErrorMessage(error)}`;
      if (directProvider) {
        const failedTurn =
          capturedTurn ??
          finishDirectTurn(
            turnBuilder,
            "failed",
            getErrorMessage(error),
          );
        await persistDirectTurn({
          turn: failedTurn,
          replayEvidence:
            capturedReplayEvidence ??
            directFallbackReplayEvidence("stream_failed"),
          toolCorrelations:
            Object.keys(capturedToolCorrelations).length > 0
              ? capturedToolCorrelations
              : inferDirectToolCorrelations(failedTurn),
          isError: true,
          errorMessage: getErrorMessage(error),
        });
        assistantBubble.bodyEl.addClass("is-error");
        transcript.renderPlainTextContent(assistantBubble, errorText);
      } else {
        if (finalization.kind === "replace") {
          store.finalizeRegeneration(finalization.oldMessage, finalization.oldMessage.content);
        }
        const errorMessage = makeMessage("assistant", errorText);
        errorMessage.isError = true;
        errorMessage.modelId = activeModel.modelId;
        errorMessage.provider = activeModel.provider;
        const partialSteps = timeline?.getSteps();
        if (hasCompletedAskGuidance(partialSteps)) {
          errorMessage.agenticSteps = partialSteps;
        }
        store.appendMessage(errorMessage);
        transcript.registerBubble(errorMessage.id, assistantBubble);
        assistantBubble.bodyEl.addClass("is-error");
        transcript.renderPlainTextContent(assistantBubble, errorText);
      }
    }
  } finally {
    plugin.services.claudeCode.setAskUserResponder(null);
    plugin.services.claudeCode.setToolListener(null);
    plugin.services.claudeCode.setLiveReview(null);
    // Resolve any op still parked on the user so no await leaks past the turn.
    liveReview.cancelPending();
    // The generation owns exactly one coordinator. Destroying it settles any
    // remaining interaction before the active generation state is cleared.
    askCoordinator.destroy();
    setActiveAbortController(null);
    await store.persistActiveConversation();
    setIsGenerating(false);
    renderer.destroy();
  }
}

function finishDirectTurn(
  builder: AssistantTurnBuilder,
  status: "interrupted" | "failed",
  errorMessage: string,
): AssistantTurnRecord {
  if (status === "failed") {
    for (const item of builder.snapshot().items) {
      if (
        item.type === "tool_call" &&
        item.toolCallId &&
        (item.state === "declared" || item.state === "running")
      ) {
        builder.updateToolLifecycle(item.toolCallId, {
          state: "failed",
          isError: true,
          errorContent: errorMessage,
        });
      }
    }
  }
  try {
    return builder.finishTurn(status);
  } catch {
    return {
      schemaVersion: 1,
      id: builder.snapshot().id,
      status,
      segments: [],
      items: [],
    };
  }
}

function inferDirectToolCorrelations(
  turn: AssistantTurnRecord,
): Record<string, "provider_id" | "plugin_id"> {
  return Object.fromEntries(
    turn.items
      .filter((item) => item.type === "tool_call")
      .map((item) => [
        item.toolCallId,
        item.toolCallId.startsWith("lmsa-tool-")
          ? "plugin_id"
          : "provider_id",
      ]),
  );
}

function directFallbackReplayEvidence(
  loweredReason: string,
): AssistantReplayEvidence {
  return {
    tier: "textual",
    capabilities: {
      captureOrder: "text_only",
      toolCorrelation: "none",
      coldReplay: "textual",
      nativeResume: false,
    },
    loweredReason,
  };
}

function anchorParsedEditTurn(
  turn: AssistantTurnRecord,
  actionRef: string,
): { turn: AssistantTurnRecord; itemId: string } {
  const items = structuredClone(turn.items);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type !== "prose") continue;
    items[index] = {
      ...item,
      actionRef,
      actionAnchor: "parsed_edit",
    };
    return {
      turn: {
        ...structuredClone(turn),
        items,
      },
      itemId: item.id,
    };
  }
  throw new Error("Parsed edit response has no prose item to anchor.");
}

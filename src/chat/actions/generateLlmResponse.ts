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
  AgenticStep,
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
import { extractToolInput } from "../../tools/metadata";
import {
  captureStepFields,
  hasCompletedAskGuidance,
} from "../../tools/resultDigest";
import { CONTEXT_DANGER_THRESHOLD } from "../../constants";
import type { ComposerInteractionHostPort } from "../interactions/ComposerInteractionHost";
import { AskInteractionCoordinator } from "../interactions/AskInteractionCoordinator";
import { generateId } from "../../utils";
import {
  AssistantTurnBuilder,
  type AssistantTurnSnapshot,
} from "../turns/AssistantTurnBuilder";
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
import { projectRegexEditPreview } from "../messages/regexEditPreview";

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

  // Two distinct agentic shapes feed the timeline:
  //  - pluginAgentic: the plugin runs its own tool loop (tools attached to the
  //    request). Its ordered provider events already update the canonical builder.
  //  - claudeCodeAgentic: Claude Code runs its loop internally over MCP. Its text
  //    streams through the legacy compatibility projection until Phase 5 adds
  //    structural subprocess capture.
  const pluginAgentic = !!apiMessages.tools?.length;
  const claudeCodeAgentic =
    activeModel.provider === "claudecode" && plugin.settings.agenticMode;
  const legacySteps: AgenticStep[] = [];
  const runningLegacyToolIds = new Set<string>();
  let latestSnapshot = turnBuilder.snapshot();
  const refreshLiveTurn = (snapshot: AssistantTurnSnapshot): void => {
    latestSnapshot = snapshot;
    if (directProvider) {
      void assistantBubble.turnView.refresh(snapshot, {
        regexEditPreview:
          editsActive && !pluginAgentic
            ? projectRegexEditPreview(snapshot)
            : null,
      });
      return;
    }
    void assistantBubble.turnView.refreshLegacy({
      key: draftIdentity.turnId,
      status: snapshot.status,
      content: allVisibleProse(snapshot),
      steps: legacySteps,
      runningToolCallIds: runningLegacyToolIds,
    });
  };
  const refreshLegacyTurn = (): void => {
    refreshLiveTurn(latestSnapshot);
  };
  refreshLiveTurn(latestSnapshot);

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
    timelineEl: assistantBubble.turnView.rootEl,
    findActionHostByToolCallId: (toolCallId) =>
      assistantBubble.turnView.getReviewHostForToolCallId(toolCallId),
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
    await assistantBubble.turnView.refresh(input.turn, {
      actionLedger,
      ...(input.errorMessage === undefined
        ? {}
        : { errorMessage: input.errorMessage }),
    });
    await assistantBubble.turnView.flush();
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

    // Claude Code's tools fire inside its subprocess over MCP. Phase 4 keeps the
    // existing conservative legacy evidence and projects it through the unified
    // view. Phase 5 owns structural subprocess correlation.
    if (claudeCodeAgentic) {
      plugin.services.claudeCode.setAskUserResponder(
        askCoordinator,
        abortController.signal,
      );
      plugin.services.claudeCode.setLiveReview(liveReview);
      plugin.services.claudeCode.setToolListener((event) => {
        if (event.phase === "start") {
          runningLegacyToolIds.add(event.toolCallId);
          if (
            !legacySteps.some(
              (step) => step.toolCallId === event.toolCallId,
            )
          ) {
            legacySteps.push({
              type: "tool_call",
              round: 0,
              toolName: event.toolName,
              toolCallId: event.toolCallId,
            });
          }
        } else {
          runningLegacyToolIds.delete(event.toolCallId);
          const completedStep: AgenticStep = {
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
          };
          const stepIndex = legacySteps.findIndex(
            (step) => step.toolCallId === event.toolCallId,
          );
          if (stepIndex === -1) {
            legacySteps.push(completedStep);
          } else {
            legacySteps[stepIndex] = completedStep;
          }
        }
        refreshLegacyTurn();
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
        onDelta: () => undefined,
        onTurnSnapshot: refreshLiveTurn,
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

    if (directProvider) {
      await assistantBubble.turnView.refresh(turn);
    } else {
      latestSnapshot = turn;
      await assistantBubble.turnView.refreshLegacy({
        key: draftIdentity.turnId,
        status: turn.status,
        content: allVisibleProse(turn),
        steps: legacySteps,
      });
    }
    await assistantBubble.turnView.flush();

    // Claude Code reports its own context window per turn (its catalog aliases
    // carry no static size); record it so the capacity ring's fallback lookup
    // resolves from the next recalculation on.
    if (finalUsage?.contextWindow) {
      plugin.services.modelAvailability.reportContextWindow(
        activeModel.modelId,
        finalUsage.contextWindow,
      );
    }

    const agenticSteps =
      legacySteps.length > 0 ? structuredClone(legacySteps) : undefined;

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
    } else if (editsActive) {
      // Drop the transient in-loop edit panel so it can't double up with the
      // durable one finalize renders into the message body.
      liveReview.detachEditPanel();
      await finalizeEditResponse({
        app: plugin.app,
        owner,
        store,
        transcript,
        bubble: assistantBubble,
        response: allVisibleProse(turn),
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
      const response = allVisibleProse(turn);
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
        allVisibleProse(turn),
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
    if (isAbortError(error) || abortController.signal.aborted) {
      const partialSteps =
        legacySteps.length > 0 ? structuredClone(legacySteps) : undefined;
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
      } else if (editsActive) {
        liveReview.detachEditPanel();
        await finalizeEditResponse({
          app: plugin.app,
          owner,
          store,
          transcript,
          bubble: assistantBubble,
          response: allVisibleProse(latestSnapshot),
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
        const response = allVisibleProse(latestSnapshot);
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
          allVisibleProse(latestSnapshot),
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
      } else {
        if (finalization.kind === "replace") {
          store.finalizeRegeneration(finalization.oldMessage, finalization.oldMessage.content);
        }
        const errorMessage = makeMessage("assistant", errorText);
        errorMessage.isError = true;
        errorMessage.modelId = activeModel.modelId;
        errorMessage.provider = activeModel.provider;
        const partialSteps =
          legacySteps.length > 0 ? structuredClone(legacySteps) : undefined;
        if (hasCompletedAskGuidance(partialSteps)) {
          errorMessage.agenticSteps = partialSteps;
        }
        store.appendMessage(errorMessage);
        transcript.registerBubble(errorMessage.id, assistantBubble);
        await assistantBubble.turnView.refreshLegacy({
          key: errorMessage.id,
          status: "failed",
          content: "",
          steps: partialSteps,
          errorMessage: getErrorMessage(error),
        });
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

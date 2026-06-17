import type { Component } from "obsidian";
import { Notice } from "obsidian";
import { buildSamplingParams } from "../finalization/buildSamplingParams";
import type WritingAssistantChat from "../../main";
import type { ChatClient } from "../../api/chatClient";
import type { ChatComposer } from "../composer/ChatComposer";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";
import type { ChatTranscript } from "../messages/ChatTranscript";
import type { CompletionModel, ConversationMessage } from "../../shared/types";
import { getActiveProfile } from "../../shared/profileUtils";
import { makeMessage } from "../conversation/conversationUtils";
import { prepareApiMessages } from "../finalization/prepareApiMessages";
import { estimateTokenCount } from "../../shared/tokenEstimation";
import { StreamingRenderer } from "../streaming/StreamingRenderer";
import { EditStreamingRenderer } from "../streaming/EditStreamingRenderer";
import { finalizeResponse, finalizeAbortedResponse } from "../finalization/finalizeResponse";
import { finalizeEditResponse } from "../finalization/finalizeEditResponse";
import { estimateCost } from "../../api/pricing";
import type { UsageResult } from "../../api/usageTypes";
import type { MessageUsage } from "../../shared/types";
import { runToolLoop } from "./toolLoop";
import type { VaultToolContext, ToolExecutionContext, VaultOpToolContext } from "./toolLoop";
import { LiveVaultReview } from "./liveVaultReview";
import { AgenticTimeline } from "../messages/AgenticTimeline";
import { extractToolInput } from "../../tools/metadata";
import { CONTEXT_DANGER_THRESHOLD } from "../../constants";

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
  composer: ChatComposer;
  activeModel: CompletionModel;
  client: ChatClient;
  editMode: boolean;
  finalization: FinalizationMode;
  setIsGenerating: (v: boolean) => void;
  setActiveAbortController: (c: AbortController | null) => void;
  onCalibrate?: (estimated: number, actual: number) => void;
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
    estimatedCostUsd: estimateCost(modelId, usage) ?? undefined,
  };
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
    composer,
    activeModel,
    client,
    editMode,
    finalization,
    setIsGenerating,
    setActiveAbortController,
    onCalibrate,
  } = options;

  const activeProfile = getActiveProfile(plugin.settings, activeModel.provider);

  const apiMessages = await prepareApiMessages({
    app: plugin.app,
    store,
    settings: plugin.settings,
    activeNoteAttached: composer.isActiveNoteAttached(),
    extraContextItems: composer.getExtraContextItems(),
    maxContextChars: plugin.settings.maxContextChars,
    mode: editMode ? "edit" : "conversation",
    ragService: plugin.services.ragService,
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
    supportsVision: activeModel.vision
      ?? plugin.services.modelAvailability.getVision(activeModel.modelId)
      ?? false,
  });

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

  const contextWindow =
    activeModel.contextWindowSize ??
    plugin.services.modelAvailability.getActiveContextLength(activeModel.modelId);
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
  const useToolMode = editMode && !!apiMessages.tools?.length;
  const renderer = editMode
    ? new EditStreamingRenderer(assistantBubble, transcript, { useToolMode })
    : new StreamingRenderer(assistantBubble, transcript);

  // Two distinct agentic shapes feed the timeline:
  //  - pluginAgentic: the plugin runs its own tool loop (tools attached to the
  //    request). Deltas are buffered per round and only the final round reaches
  //    the bubble; the timeline is driven by the loop's callbacks, created eagerly.
  //  - claudeCodeAgentic: Claude Code runs its loop internally over MCP. Its text
  //    streams straight to the bubble (no buffering) and the timeline is driven by
  //    the service's tool-lifecycle events — created lazily on the first tool call
  //    so tool-less turns (the common case) don't render an empty timeline.
  const pluginAgentic = !!apiMessages.tools?.length;
  const claudeCodeAgentic =
    activeModel.provider === "claudecode" && plugin.settings.agenticMode;
  // pluginTimeline is the eager instance the tool-loop callbacks write to (const,
  // so they narrow cleanly). `timeline` tracks whichever instance exists for
  // finalization — it starts as pluginTimeline and is filled lazily on the
  // Claude Code path when its first MCP tool call arrives.
  const pluginTimeline = pluginAgentic
    ? new AgenticTimeline(assistantBubble.timelineEl)
    : null;
  let timeline: AgenticTimeline | null = pluginTimeline;

  const vaultToolContext: VaultToolContext = {
    app: plugin.app,
    ragService: plugin.services.ragService,
    // Edit mode carries the active note in documentContext; in chat mode the note
    // moved into a message attachment, so fall back to the current active file.
    activeFilePath: apiMessages.documentContext?.filePath ?? plugin.app.workspace.getActiveFile()?.path,
  };

  const editToolContext: ToolExecutionContext | undefined =
    editMode
      ? { app: plugin.app, filePath: apiMessages.documentContext?.filePath ?? "" }
      : undefined;

  // The in-loop review coordinator: owns the live vault-op proposal, mounts the
  // review on the streaming timeline, applies auto ops, and suspends the loop on
  // ask-gated ops until the user decides (in-loop-tool-approval-blocking-flow). In
  // edit mode it also owns the edit channel, rendering the live diff in this host
  // (propose-edit-in-loop-blocking-review).
  const editReviewHost = editMode
    ? assistantBubble.bodyEl.createDiv({ cls: "lmsa-edit-review-live" })
    : null;
  const liveReview = new LiveVaultReview({
    app: plugin.app,
    timelineEl: assistantBubble.timelineEl,
    policy: plugin.settings.vaultOpPolicy,
    ...(editReviewHost && {
      edit: {
        host: editReviewHost,
        owner,
        inlineDiff: plugin.inlineDiff,
        resolveOptions: {
          contextLines: plugin.settings.diffContextLines,
          minConfidence: plugin.settings.diffMinMatchConfidence,
        },
      },
    }),
  });

  // Vault ops operate on arbitrary paths, so they need only the app + the live
  // review; the coordinator rebuilds the pending overlay per round.
  const vaultOpToolContext: VaultOpToolContext = { app: plugin.app, liveReview };

  const abortController = new AbortController();
  setActiveAbortController(abortController);
  // Abort (stop button, or a new user turn superseding this one) must resolve any
  // op parked on the user, or a suspended loop would hang forever on the await.
  abortController.signal.addEventListener("abort", () => liveReview.cancelPending());

  const editRenderer = renderer instanceof EditStreamingRenderer ? renderer : null;
  const chatRenderer = renderer instanceof StreamingRenderer ? renderer : null;

  try {

    const maxRounds = apiMessages.documentContext?.filePath
      ? plugin.settings.maxToolRoundsEdit
      : plugin.settings.maxToolRoundsChat;

    // Only the plugin-owned tool loop buffers deltas; Claude Code streams live.
    const agenticMode = pluginAgentic;

    // Claude Code's tools fire inside its subprocess over MCP, not through the
    // tool loop — route those lifecycle events into the same timeline, created on
    // first use so tool-less turns stay clean.
    if (claudeCodeAgentic) {
      plugin.services.claudeCode.setLiveReview(liveReview);
      plugin.services.claudeCode.setToolListener((event) => {
        const tl = timeline ?? (timeline = new AgenticTimeline(assistantBubble.timelineEl));
        if (event.phase === "start") {
          tl.addPendingToolCall(event.toolName);
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
          });
        }
      });
    }

    const { writeToolCalls, usage: finalUsage, writeStopReason } = await runToolLoop(
      client,
      apiMessages,
      activeModel.modelId,
      buildSamplingParams(activeProfile),
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
        // driven by the MCP listener below — so they stay unset there to avoid
        // mirroring the streamed answer text into the timeline as reasoning.
        onToolCallStreaming: pluginTimeline ? (name) => pluginTimeline.addPendingToolCall(name) : undefined,
        onStepRecorded: pluginTimeline ? (step) => pluginTimeline.addStep(step) : undefined,
        onReasoningDelta: pluginTimeline ? (delta) => pluginTimeline.addReasoningDelta(delta) : undefined,
        onReasoningRoundFinished: pluginTimeline
          ? (committed, round) => {
              if (committed) {
                pluginTimeline.commitLiveReasoning(round);
              } else {
                pluginTimeline.discardLiveReasoning();
              }
            }
          : undefined,
        onCalibrate: onCalibrate
          ? (request, usage) => {
              const estimated = estimateTokenCount(request);
              onCalibrate(estimated, usage.inputTokens);
            }
          : undefined,
      },
      maxRounds,
      agenticMode,
      vaultToolContext,
      editToolContext,
      vaultOpToolContext,
    );

    await renderer.flush();
    assistantBubble.bodyEl.removeClass("is-streaming");

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

    if (editMode && renderer instanceof EditStreamingRenderer) {
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
        prebuiltVaultOpProposal: liveReview.getProposal() ?? undefined,
        prebuiltVaultOpRecord: liveReview.getAppliedRecord() ?? undefined,
        prebuiltEditProposal: liveReview.getEditProposal() ?? undefined,
        prebuiltEditRecord: liveReview.getEditAppliedRecord() ?? undefined,
      });
    } else if (finalization.kind === "replace") {
      const response = chatRenderer?.getCurrentRoundResponse() ?? "";
      if (response) {
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

    if (isAbortError(error)) {
      const partialSteps = timeline?.getSteps();
      if (editMode && renderer instanceof EditStreamingRenderer) {
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
          prebuiltVaultOpProposal: liveReview.getProposal() ?? undefined,
          prebuiltVaultOpRecord: liveReview.getAppliedRecord() ?? undefined,
          prebuiltEditProposal: liveReview.getEditProposal() ?? undefined,
          prebuiltEditRecord: liveReview.getEditAppliedRecord() ?? undefined,
        });
      } else if (finalization.kind === "replace") {
        const response = chatRenderer?.getCurrentRoundResponse() ?? "";
        if (response) {
          store.finalizeRegeneration(finalization.oldMessage, response, {
            modelId: activeModel.modelId,
            provider: activeModel.provider,
            ...(partialSteps?.length && { agenticSteps: partialSteps }),
          });
          transcript.registerBubble(finalization.oldMessage.id, assistantBubble);
        } else {
          transcript.renderPlainTextContent(assistantBubble, "Generation stopped.");
          assistantBubble.bodyEl.addClass("is-muted");
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
      if (finalization.kind === "replace") {
        store.finalizeRegeneration(finalization.oldMessage, finalization.oldMessage.content);
      }
      const errorMessage = makeMessage("assistant", errorText);
      errorMessage.isError = true;
      errorMessage.modelId = activeModel.modelId;
      errorMessage.provider = activeModel.provider;
      store.appendMessage(errorMessage);
      transcript.registerBubble(errorMessage.id, assistantBubble);
      assistantBubble.bodyEl.addClass("is-error");
      transcript.renderPlainTextContent(assistantBubble, errorText);
    }
  } finally {
    plugin.services.claudeCode.setToolListener(null);
    plugin.services.claudeCode.setLiveReview(null);
    // Resolve any op still parked on the user so no await leaks past the turn.
    liveReview.cancelPending();
    setActiveAbortController(null);
    await store.persistActiveConversation();
    setIsGenerating(false);
    renderer.destroy();
  }
}

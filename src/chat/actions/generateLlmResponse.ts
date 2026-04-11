import type { Component } from "obsidian";
import { Notice } from "obsidian";
import { buildSamplingParams } from "../finalization/buildSamplingParams";
import type LMStudioWritingAssistant from "../../main";
import type { ChatClient } from "../../api/chatClient";
import type { ChatComposer } from "../composer/ChatComposer";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";
import type { ChatTranscript } from "../messages/ChatTranscript";
import type { CompletionModel, ConversationMessage } from "../../shared/types";
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
import type { VaultToolContext, ToolExecutionContext } from "./toolLoop";
import { AgenticTimeline } from "../messages/AgenticTimeline";
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
  plugin: LMStudioWritingAssistant;
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
  syncConversationUi: () => Promise<void>;
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
    syncConversationUi,
    onCalibrate,
  } = options;

  const apiMessages = await prepareApiMessages({
    app: plugin.app,
    store,
    settings: plugin.settings,
    includeNoteContext: plugin.settings.includeNoteContext,
    sessionContextEnabled: composer.isSessionContextEnabled(),
    maxContextChars: plugin.settings.maxContextChars,
    mode: editMode ? "edit" : "conversation",
    ragService: plugin.ragService,
    activeProvider: activeModel.provider,
    modelCapabilities: {
      trainedForToolUse:
        activeModel.trainedForToolUse ??
        plugin.modelAvailability.getTrainedForToolUse(activeModel.modelId),
    },
    chatClient: client,
    completionModelId: activeModel.modelId,
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

  if (activeModel.anthropicCacheSettings?.enabled) {
    apiMessages.anthropicCacheSettings = activeModel.anthropicCacheSettings;
  }

  await store.persistActiveConversation();

  const contextWindow =
    activeModel.contextWindowSize ??
    plugin.modelAvailability.getActiveContextLength(activeModel.modelId);
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

  // Create an agentic timeline when tools are included in the request.
  const timeline = apiMessages.tools?.length
    ? new AgenticTimeline(assistantBubble.timelineEl)
    : null;

  const vaultToolContext: VaultToolContext = {
    app: plugin.app,
    ragService: plugin.ragService,
    activeFilePath: apiMessages.documentContext?.filePath,
  };

  const editToolContext: ToolExecutionContext | undefined =
    editMode
      ? { app: plugin.app, filePath: apiMessages.documentContext?.filePath ?? "" }
      : undefined;

  const abortController = new AbortController();
  setActiveAbortController(abortController);

  try {
    const editRenderer = renderer instanceof EditStreamingRenderer ? renderer : null;
    const chatRenderer = renderer instanceof StreamingRenderer ? renderer : null;

    const maxRounds = apiMessages.documentContext?.filePath
      ? plugin.settings.maxToolRoundsEdit
      : plugin.settings.maxToolRoundsChat;

    const agenticMode = !!timeline;

    const { writeToolCalls, usage: finalUsage } = await runToolLoop(
      client,
      apiMessages,
      activeModel.modelId,
      buildSamplingParams(plugin.settings),
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
        onToolCallStreaming: timeline ? (name) => timeline.addPendingToolCall(name) : undefined,
        onStepRecorded: timeline ? (step) => timeline.addStep(step) : undefined,
        onReasoningDelta: timeline ? (delta) => timeline.addReasoningDelta(delta) : undefined,
        onReasoningRoundFinished: timeline
          ? (committed, round) => {
              if (committed) {
                timeline.commitLiveReasoning(round);
              } else {
                timeline.discardLiveReasoning();
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
    );

    await renderer.flush();
    assistantBubble.bodyEl.removeClass("is-streaming");

    const agenticSteps = timeline?.getSteps();

    if (editMode && renderer instanceof EditStreamingRenderer) {
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
        toolCalls: writeToolCalls,
        agenticSteps,
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
        });
      } else if (finalization.kind === "replace") {
        const response = chatRenderer?.getCurrentRoundResponse() ?? "";
        if (response) {
          store.finalizeRegeneration(finalization.oldMessage, response, {
            modelId: activeModel.modelId,
            provider: activeModel.provider,
            ...(partialSteps?.length && { agenticSteps: partialSteps }),
          });
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
      assistantBubble.bodyEl.addClass("is-error");
      transcript.renderPlainTextContent(assistantBubble, errorText);
    }
  } finally {
    setActiveAbortController(null);
    await store.persistActiveConversation();
    setIsGenerating(false);
    renderer.destroy();
    await syncConversationUi();
  }
}

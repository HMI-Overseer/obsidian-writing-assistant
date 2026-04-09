import type { Component } from "obsidian";
import { Notice } from "obsidian";
import { createChatClient } from "../../providers/registry";
import { buildSamplingParams } from "./buildSamplingParams";
import type LMStudioWritingAssistant from "../../main";
import type { ChatComposer } from "../composer/ChatComposer";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";
import type { ChatTranscript } from "../messages/ChatTranscript";
import type { ChatModelSelector } from "../models/ChatModelSelector";
import { makeMessage } from "../conversation/conversationUtils";
import { prepareApiMessages } from "./prepareApiMessages";
import { estimateTokenCount } from "../../shared/tokenEstimation";
import { StreamingRenderer } from "./StreamingRenderer";
import { EditStreamingRenderer } from "./EditStreamingRenderer";
import { finalizeEditResponse } from "./finalizeEditResponse";
import { READ_ONLY_TOOL_NAMES } from "../../tools/editing/definition";
import { executeReadOnlyTool } from "../../tools/editing/handlers";
import type { ToolCall } from "../../tools/types";
import type { ChatTurn } from "../../shared/chatRequest";
import { estimateCost } from "../../api/pricing";
import type { UsageResult } from "../../api/usageTypes";
import type { MessageUsage } from "../../shared/types";

/** Maximum number of read-only tool rounds before forcing finalization. */
const MAX_TOOL_ROUNDS = 5;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
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

export type RegenerateOptions = {
  plugin: LMStudioWritingAssistant;
  owner: Component;
  store: ChatSessionStore;
  transcript: ChatTranscript;
  composer: ChatComposer;
  modelSelector: ChatModelSelector;
  messageId: string;
  getIsGenerating: () => boolean;
  setIsGenerating: (generating: boolean) => void;
  setActiveAbortController: (controller: AbortController | null) => void;
  syncConversationUi: () => Promise<void>;
  onCalibrate?: (estimatedTokens: number, actualTokens: number) => void;
};

export async function regenerateMessage(options: RegenerateOptions): Promise<void> {
  const {
    plugin,
    owner,
    store,
    transcript,
    composer,
    modelSelector,
    messageId,
    getIsGenerating,
    setIsGenerating,
    setActiveAbortController,
    syncConversationUi,
    onCalibrate,
  } = options;

  if (getIsGenerating()) return;

  const snapshot = store.getSnapshot();
  const lastMessage = snapshot.messageHistory[snapshot.messageHistory.length - 1];
  if (!lastMessage || lastMessage.id !== messageId || lastMessage.role !== "assistant") {
    new Notice("Can only regenerate the last assistant response.");
    return;
  }

  const activeModel = store.getResolvedConversationModel();
  if (!activeModel?.modelId) {
    new Notice("No model selected.");
    return;
  }

  const availabilityState = await modelSelector.refreshAvailability();
  if (availabilityState !== "loaded" && availabilityState !== "cloud") {
    modelSelector.retriggerAttention();
    return;
  }

  const mode = composer.getMode();
  const editMode = mode === "edit";

  const oldMessage = store.removeLastMessage();
  if (!oldMessage) return;

  setIsGenerating(true);

  await store.persistActiveConversation();
  await syncConversationUi();

  const apiMessages = await prepareApiMessages({
    app: plugin.app,
    store,
    settings: plugin.settings,
    includeNoteContext: plugin.settings.includeNoteContext,
    sessionContextEnabled: composer.isSessionContextEnabled(),
    maxContextChars: plugin.settings.maxContextChars,
    mode,
    ragService: plugin.ragService,
    activeProvider: activeModel.provider,
    modelCapabilities: {
      trainedForToolUse: activeModel.trainedForToolUse
        ?? plugin.modelAvailability.getTrainedForToolUse(activeModel.modelId),
    },
    preferToolUse: plugin.settings.preferToolUse,
  });

  const ragSources = apiMessages.ragContext?.map(({ filePath, headingPath, score, content, graphContext }) =>
    ({ filePath, headingPath, score, content, graphContext })
  );
  const { rewrittenQuery } = apiMessages;

  // Attach Anthropic cache settings if enabled on the active model.
  if (activeModel.anthropicCacheSettings?.enabled) {
    apiMessages.anthropicCacheSettings = activeModel.anthropicCacheSettings;
  }

  const assistantBubble = transcript.createBubble("assistant");
  assistantBubble.bodyEl.addClass("is-streaming");

  const useToolMode = editMode && !!apiMessages.tools?.length;
  const renderer = editMode
    ? new EditStreamingRenderer(assistantBubble, transcript, { useToolMode })
    : new StreamingRenderer(assistantBubble, transcript);

  const client = createChatClient(activeModel.provider, plugin.settings.providerSettings);
  const abortController = new AbortController();
  setActiveAbortController(abortController);

  try {
    const toolLoopTurns: ChatTurn[] = [];
    let allWriteToolCalls: ToolCall[] = [];
    let previousRoundsText = "";
    let finalUsage: UsageResult | null = null;
    let calibrated = false;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const requestMessages = [...apiMessages.messages, ...toolLoopTurns];
      const roundRequest = { ...apiMessages, messages: requestMessages };

      const streamResult = client.stream(
        roundRequest,
        activeModel.modelId,
        buildSamplingParams(plugin.settings),
        abortController.signal
      );

      for await (const delta of streamResult.deltas) {
        renderer.appendDelta(delta);
      }

      const usage = await streamResult.usage;
      const toolCalls = await streamResult.toolCalls;
      const stopReason = await streamResult.stopReason;

      if (usage && onCalibrate && !calibrated) {
        const estimated = estimateTokenCount(roundRequest);
        onCalibrate(estimated, usage.inputTokens);
        calibrated = true;
      }
      if (usage) finalUsage = usage;

      const totalText = renderer instanceof EditStreamingRenderer
        ? renderer.getFullResponse()
        : (renderer as StreamingRenderer).getFullResponse();
      const roundText = totalText.slice(previousRoundsText.length);

      const hasToolCalls = toolCalls !== null && toolCalls.length > 0;

      const textContent = roundText.trim();
      const looksLikeFailedToolCall = !hasToolCalls && (
        !textContent
        || textContent.startsWith("[TOOL_CALLS]")
        || textContent.startsWith("[TOOL_REQUEST]")
        || (stopReason === "tool_use")
      );

      if (looksLikeFailedToolCall) {
        throw new Error(
          "The model attempted a tool call but failed to generate valid output. " +
          "Try regenerating or switching to a more capable model."
        );
      }

      if (!toolCalls || toolCalls.length === 0) break;

      const readOnlyCalls = toolCalls.filter((tc) => READ_ONLY_TOOL_NAMES.has(tc.name));
      const writeCalls = toolCalls.filter((tc) => !READ_ONLY_TOOL_NAMES.has(tc.name));
      allWriteToolCalls = [...allWriteToolCalls, ...writeCalls];

      if (readOnlyCalls.length > 0 && writeCalls.length === 0 && round < MAX_TOOL_ROUNDS) {
        const filePath = apiMessages.documentContext?.filePath;
        if (!filePath) break;

        const assistantTurn: ChatTurn = {
          role: "assistant",
          content: roundText || null,
          toolCalls: readOnlyCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          })),
        };
        toolLoopTurns.push(assistantTurn);

        for (const tc of readOnlyCalls) {
          if (renderer instanceof EditStreamingRenderer) {
            renderer.showToolStatus(tc.name);
          }

          const result = await executeReadOnlyTool(tc, { app: plugin.app, filePath });
          toolLoopTurns.push({
            role: "tool",
            content: result.content,
            toolCallId: tc.id,
          });
        }

        previousRoundsText = totalText;

        if (renderer instanceof EditStreamingRenderer) {
          renderer.beginNewRound();
        }

        continue;
      }

      break;
    }

    const finalToolCalls = allWriteToolCalls.length > 0 ? allWriteToolCalls : null;

    await renderer.flush();
    assistantBubble.bodyEl.removeClass("is-streaming");

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
        toolCalls: finalToolCalls,
      });
    } else {
      const fullResponse = renderer.getFullResponse();
      if (fullResponse) {
        store.finalizeRegeneration(oldMessage, fullResponse, {
          modelId: activeModel.modelId,
          provider: activeModel.provider,
          ...(finalUsage && { usage: buildMessageUsage(activeModel.modelId, finalUsage) }),
          ragSources,
          rewrittenQuery,
        });
      } else {
        transcript.renderPlainTextContent(assistantBubble, "(no response)");
      }
    }

  } catch (error) {
    await renderer.flush();
    assistantBubble.bodyEl.removeClass("is-streaming");

    if (isAbortError(error)) {
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
        });
      } else {
        const fullResponse = renderer.getFullResponse();
        if (fullResponse) {
          store.finalizeRegeneration(oldMessage, fullResponse, {
            modelId: activeModel.modelId,
            provider: activeModel.provider,
          });
        } else {
          transcript.renderPlainTextContent(assistantBubble, "Generation stopped.");
          assistantBubble.bodyEl.addClass("is-muted");
        }
      }
    } else {
      const errorText = `Error: ${getErrorMessage(error)}`;
      if (!editMode) {
        // Restore the old message first, then append the error as a separate message.
        store.finalizeRegeneration(oldMessage, oldMessage.content);
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

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
import { estimateCost } from "../../api/pricing";
import type { UsageResult } from "../../api/usageTypes";
import type { MessageUsage } from "../../shared/types";

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

  const editMode = composer.getMode() === "edit";

  const oldMessage = store.removeLastMessage();
  if (!oldMessage) return;

  setIsGenerating(true);

  await store.persistActiveConversation();
  await syncConversationUi();

  const apiMessages = await prepareApiMessages({
    app: plugin.app,
    store,
    globalSystemPrompt: plugin.settings.globalSystemPrompt,
    includeNoteContext: plugin.settings.includeNoteContext,
    sessionContextEnabled: composer.isSessionContextEnabled(),
    maxContextChars: plugin.settings.maxContextChars,
    editMode,
    ragService: plugin.ragService,
  });

  // Attach Anthropic cache settings if enabled on the active model.
  if (activeModel.anthropicCacheSettings?.enabled) {
    apiMessages.anthropicCacheSettings = activeModel.anthropicCacheSettings;
  }

  const assistantBubble = transcript.createBubble("assistant");
  assistantBubble.bodyEl.addClass("is-streaming");

  const renderer = editMode
    ? new EditStreamingRenderer(assistantBubble, transcript)
    : new StreamingRenderer(assistantBubble, transcript);

  const client = createChatClient(activeModel.provider, plugin.settings.providerSettings);
  const abortController = new AbortController();
  setActiveAbortController(abortController);

  try {
    const streamResult = client.stream(
      apiMessages,
      activeModel.modelId,
      buildSamplingParams(plugin.settings),
      abortController.signal
    );

    for await (const delta of streamResult.deltas) {
      renderer.appendDelta(delta);
    }

    const usage = await streamResult.usage;
    if (usage && onCalibrate) {
      const estimated = estimateTokenCount(apiMessages);
      onCalibrate(estimated, usage.inputTokens);
    }

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
        usage,
      });
    } else {
      const fullResponse = renderer.getFullResponse();
      if (fullResponse) {
        store.finalizeRegeneration(oldMessage, fullResponse, {
          modelId: activeModel.modelId,
          provider: activeModel.provider,
          ...(usage && { usage: buildMessageUsage(activeModel.modelId, usage) }),
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

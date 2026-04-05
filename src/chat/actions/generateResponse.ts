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
import { finalizeResponse, finalizeAbortedResponse } from "./finalizeResponse";
import { finalizeEditResponse } from "./finalizeEditResponse";
import { runToolLoop } from "./toolLoop";

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Unknown error";
}

export type GenerateResponseOptions = {
  plugin: LMStudioWritingAssistant;
  owner: Component;
  store: ChatSessionStore;
  transcript: ChatTranscript;
  composer: ChatComposer;
  modelSelector: ChatModelSelector;
  getIsGenerating: () => boolean;
  setIsGenerating: (generating: boolean) => void;
  setActiveAbortController: (controller: AbortController | null) => void;
  syncConversationUi: () => Promise<void>;
  onCalibrate?: (estimatedTokens: number, actualTokens: number) => void;
};

export async function generateResponse(options: GenerateResponseOptions): Promise<void> {
  const {
    plugin,
    owner,
    store,
    transcript,
    composer,
    modelSelector,
    getIsGenerating,
    setIsGenerating,
    setActiveAbortController,
    syncConversationUi,
    onCalibrate,
  } = options;

  if (getIsGenerating()) return;

  const snapshot = store.getSnapshot();
  if (snapshot.messageHistory.length === 0) return;

  const lastMessage = snapshot.messageHistory[snapshot.messageHistory.length - 1];
  if (lastMessage.role !== "user" && !lastMessage.isError) return;

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

  // Remove trailing error messages before generating.
  let removed = false;
  while (store.getSnapshot().messageHistory.length > 0) {
    const msgs = store.getSnapshot().messageHistory;
    const tail = msgs[msgs.length - 1];
    if (tail.isError) {
      store.removeLastMessage();
      removed = true;
    } else {
      break;
    }
  }

  if (removed) {
    await store.persistActiveConversation();
    await syncConversationUi();
  }

  // After removing errors, verify we still have messages.
  if (store.getSnapshot().messageHistory.length === 0) return;

  const mode = composer.getMode();
  const editMode = mode === "edit";

  setIsGenerating(true);

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
  });

  const ragSources = apiMessages.ragContext?.map(({ filePath, headingPath, score, content }) =>
    ({ filePath, headingPath, score, content })
  );

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
    const editRenderer = renderer instanceof EditStreamingRenderer ? renderer : null;

    const { writeToolCalls, usage: finalUsage } = await runToolLoop(
      client,
      apiMessages,
      activeModel.modelId,
      buildSamplingParams(plugin.settings),
      abortController.signal,
      plugin.app,
      apiMessages.documentContext?.filePath,
      {
        onDelta: (delta) => renderer.appendDelta(delta),
        getFullResponse: () => renderer instanceof EditStreamingRenderer
          ? renderer.getFullResponse()
          : (renderer as StreamingRenderer).getFullResponse(),
        onToolStatus: editRenderer
          ? (name) => editRenderer.showToolStatus(name)
          : undefined,
        onNewRound: editRenderer
          ? () => editRenderer.beginNewRound()
          : undefined,
        onCalibrate: onCalibrate
          ? (request, usage) => {
            const estimated = estimateTokenCount(request);
            onCalibrate(estimated, usage.inputTokens);
          }
          : undefined,
      },
    );

    const finalToolCalls = writeToolCalls;

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
      await finalizeResponse(
        store,
        transcript,
        assistantBubble,
        renderer as StreamingRenderer,
        false,
        plugin,
        activeModel.modelId,
        activeModel.provider,
        finalUsage,
        ragSources
      );
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
        await finalizeAbortedResponse(
          store,
          transcript,
          assistantBubble,
          renderer as StreamingRenderer,
          activeModel.modelId,
          activeModel.provider,
          ragSources
        );
      }
    } else {
      const errorText = `Error: ${getErrorMessage(error)}`;
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

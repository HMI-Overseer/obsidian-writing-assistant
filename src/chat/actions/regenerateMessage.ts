import { Notice } from "obsidian";
import { LMStudioClient } from "../../api";
import type LMStudioWritingAssistant from "../../main";
import type { ChatComposer } from "../composer/ChatComposer";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";
import type { ChatTranscript } from "../messages/ChatTranscript";
import type { ChatModelSelector } from "../models/ChatModelSelector";
import { prepareApiMessages } from "./prepareApiMessages";
import { StreamingRenderer } from "./StreamingRenderer";

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Unknown error";
}

export type RegenerateOptions = {
  plugin: LMStudioWritingAssistant;
  store: ChatSessionStore;
  transcript: ChatTranscript;
  composer: ChatComposer;
  modelSelector: ChatModelSelector;
  messageId: string;
  getIsGenerating: () => boolean;
  setIsGenerating: (generating: boolean) => void;
  setActiveAbortController: (controller: AbortController | null) => void;
  syncConversationUi: () => Promise<void>;
};

export async function regenerateMessage(options: RegenerateOptions): Promise<void> {
  const {
    plugin,
    store,
    transcript,
    composer,
    modelSelector,
    messageId,
    getIsGenerating,
    setIsGenerating,
    setActiveAbortController,
    syncConversationUi,
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
  if (availabilityState !== "loaded") {
    modelSelector.retriggerAttention();
    return;
  }

  const oldMessage = store.removeLastMessage();
  if (!oldMessage) return;

  setIsGenerating(true);

  await store.persistActiveConversation();
  await syncConversationUi();

  const apiMessages = await prepareApiMessages(
    plugin.app,
    store,
    activeModel,
    plugin.settings.includeNoteContext,
    composer.isSessionContextEnabled(),
    plugin.settings.maxContextChars
  );

  const assistantBubble = transcript.createBubble("assistant");
  assistantBubble.bodyEl.addClass("is-streaming");
  const renderer = new StreamingRenderer(assistantBubble, transcript);

  const client = new LMStudioClient(plugin.settings.lmStudioUrl, plugin.settings.bypassCors);
  const abortController = new AbortController();
  setActiveAbortController(abortController);

  try {
    for await (const delta of client.stream(
      apiMessages,
      activeModel.modelId,
      activeModel.maxTokens,
      activeModel.temperature,
      abortController.signal
    )) {
      renderer.appendDelta(delta);
    }

    await renderer.flush();
    assistantBubble.bodyEl.removeClass("is-streaming");

    const fullResponse = renderer.getFullResponse();
    if (fullResponse) {
      store.finalizeRegeneration(oldMessage, fullResponse);
    } else {
      transcript.renderPlainTextContent(assistantBubble, "(no response)");
    }

  } catch (error) {
    await renderer.flush();
    assistantBubble.bodyEl.removeClass("is-streaming");

    if (isAbortError(error)) {
      const fullResponse = renderer.getFullResponse();
      if (fullResponse) {
        store.finalizeRegeneration(oldMessage, fullResponse);
      } else {
        transcript.renderPlainTextContent(assistantBubble, "Generation stopped.");
        assistantBubble.bodyEl.addClass("is-muted");
      }
    } else {
      store.finalizeRegeneration(oldMessage, oldMessage.content);
      assistantBubble.bodyEl.addClass("is-error");
      transcript.renderPlainTextContent(
        assistantBubble,
        `Error: ${getErrorMessage(error)}\n\nMake sure LM Studio is running and a model is loaded.`
      );
    }
  } finally {
    setActiveAbortController(null);
    await store.persistActiveConversation();
    setIsGenerating(false);
    renderer.destroy();
    await syncConversationUi();
  }
}

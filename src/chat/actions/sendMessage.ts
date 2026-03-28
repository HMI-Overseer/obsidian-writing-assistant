import { LMStudioClient } from "../../api";
import type LMStudioWritingAssistant from "../../main";
import type { ChatComposer } from "../composer/ChatComposer";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";
import type { ChatTranscript } from "../messages/ChatTranscript";
import type { ChatModelSelector } from "../models/ChatModelSelector";
import { makeMessage } from "../conversation/conversationUtils";
import { validateSendRequest } from "./validateSendRequest";
import { prepareApiMessages } from "./prepareApiMessages";
import { StreamingRenderer } from "./StreamingRenderer";
import { finalizeResponse, finalizeAbortedResponse } from "./finalizeResponse";

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Unknown error";
}

export type SendMessageOptions = {
  plugin: LMStudioWritingAssistant;
  store: ChatSessionStore;
  transcript: ChatTranscript;
  composer: ChatComposer;
  modelSelector: ChatModelSelector;
  getIsGenerating: () => boolean;
  setIsGenerating: (sending: boolean) => void;
  setStatus: (text: string, muted?: boolean) => void;
  setActiveAbortController: (controller: AbortController | null) => void;
  syncConversationUi: () => Promise<void>;
  promptOverride?: string;
  autoInsertAfterResponse?: boolean;
};

export async function sendMessage(options: SendMessageOptions): Promise<void> {
  const {
    plugin,
    store,
    transcript,
    composer,
    modelSelector,
    getIsGenerating,
    setIsGenerating,
    setStatus,
    setActiveAbortController,
    syncConversationUi,
    promptOverride,
    autoInsertAfterResponse = false,
  } = options;

  const validated = await validateSendRequest(
    store, composer, modelSelector, getIsGenerating(), promptOverride
  );
  if (!validated) return;

  const { text, activeModel } = validated;

  composer.clearDraft();
  store.setDraft("");
  setIsGenerating(true);
  setStatus("Generating");

  if (store.ensureConversationTitleFromFirstUserMessage(text)) {
    await syncConversationUi();
  }

  const userMessage = makeMessage("user", text);
  const userBubble = transcript.createBubble("user");
  await transcript.renderBubbleContent(userBubble, text);
  store.appendMessage(userMessage);
  transcript.setEmptyStateVisible(false);

  const apiMessages = await prepareApiMessages(
    plugin.app,
    store,
    activeModel,
    plugin.settings.includeNoteContext,
    composer.isSessionContextEnabled(),
    plugin.settings.maxContextChars
  );

  await store.persistActiveConversation();

  const assistantBubble = transcript.createBubble("assistant");
  assistantBubble.bodyEl.addClass("is-streaming");
  const renderer = new StreamingRenderer(assistantBubble, transcript);

  const client = new LMStudioClient(
    plugin.settings.lmStudioUrl,
    plugin.settings.bypassCors
  );
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

    await finalizeResponse(
      store, transcript, assistantBubble, renderer, autoInsertAfterResponse, plugin
    );

    setStatus("Ready", true);
  } catch (error) {
    await renderer.flush();
    assistantBubble.bodyEl.removeClass("is-streaming");

    if (isAbortError(error)) {
      await finalizeAbortedResponse(store, transcript, assistantBubble, renderer);
      setStatus("Stopped", true);
    } else {
      assistantBubble.bodyEl.addClass("is-error");
      transcript.renderPlainTextContent(
        assistantBubble,
        `Error: ${getErrorMessage(error)}\n\nMake sure LM Studio is running and a model is loaded.`
      );
      setStatus("Error", true);
    }
  } finally {
    setActiveAbortController(null);
    await store.persistActiveConversation();
    setIsGenerating(false);
    transcript.scrollToBottom();
    renderer.destroy();
  }
}

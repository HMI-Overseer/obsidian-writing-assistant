import type { Component } from "obsidian";
import { LMStudioClient } from "../../api";
import { buildSamplingParams } from "./buildSamplingParams";
import type LMStudioWritingAssistant from "../../main";
import type { ChatComposer } from "../composer/ChatComposer";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";
import type { ChatTranscript } from "../messages/ChatTranscript";
import type { ChatModelSelector } from "../models/ChatModelSelector";
import { makeMessage } from "../conversation/conversationUtils";
import { validateSendRequest } from "./validateSendRequest";
import { prepareApiMessages } from "./prepareApiMessages";
import { StreamingRenderer } from "./StreamingRenderer";
import { EditStreamingRenderer } from "./EditStreamingRenderer";
import { finalizeResponse, finalizeAbortedResponse } from "./finalizeResponse";
import { finalizeEditResponse } from "./finalizeEditResponse";

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
  owner: Component;
  store: ChatSessionStore;
  transcript: ChatTranscript;
  composer: ChatComposer;
  modelSelector: ChatModelSelector;
  getIsGenerating: () => boolean;
  setIsGenerating: (sending: boolean) => void;
  setActiveAbortController: (controller: AbortController | null) => void;
  syncConversationUi: () => Promise<void>;
  promptOverride?: string;
  autoInsertAfterResponse?: boolean;
  editMode?: boolean;
};

export async function sendMessage(options: SendMessageOptions): Promise<void> {
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
    promptOverride,
    autoInsertAfterResponse = false,
    editMode = false,
  } = options;

  const validated = await validateSendRequest(
    store,
    composer,
    modelSelector,
    getIsGenerating(),
    promptOverride
  );
  if (!validated) return;

  const { text, activeModel } = validated;

  // Skip any pending hunks from previous edit proposals
  const history = store.getSnapshot().messageHistory;
  let proposalChanged = false;
  for (const msg of history) {
    if (msg.editProposal) {
      for (const hunk of msg.editProposal.hunks) {
        if (hunk.status === "pending") {
          hunk.status = "rejected";
          proposalChanged = true;
        }
      }
    }
  }
  if (proposalChanged) {
    await store.persistActiveConversation();
    await syncConversationUi();
  }

  composer.clearDraft();
  store.setDraft("");
  setIsGenerating(true);

  if (store.ensureConversationTitleFromFirstUserMessage(text)) {
    await syncConversationUi();
  }

  const userMessage = makeMessage("user", text);
  const userBubble = transcript.createBubble("user");
  await transcript.renderBubbleContent(userBubble, text);
  store.appendMessage(userMessage);
  transcript.setEmptyStateVisible(false);

  const apiMessages = await prepareApiMessages({
    app: plugin.app,
    store,
    globalSystemPrompt: plugin.settings.globalSystemPrompt,
    includeNoteContext: plugin.settings.includeNoteContext,
    sessionContextEnabled: composer.isSessionContextEnabled(),
    maxContextChars: plugin.settings.maxContextChars,
    editMode,
  });

  await store.persistActiveConversation();

  const assistantBubble = transcript.createBubble("assistant");
  assistantBubble.bodyEl.addClass("is-streaming");

  const renderer = editMode
    ? new EditStreamingRenderer(assistantBubble, transcript)
    : new StreamingRenderer(assistantBubble, transcript);

  const client = new LMStudioClient(plugin.settings.lmStudioUrl, plugin.settings.bypassCors);
  const abortController = new AbortController();
  setActiveAbortController(abortController);

  try {
    for await (const delta of client.stream(
      apiMessages,
      activeModel.modelId,
      buildSamplingParams(plugin.settings),
      abortController.signal
    )) {
      renderer.appendDelta(delta);
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
      });
    } else {
      await finalizeResponse(
        store,
        transcript,
        assistantBubble,
        renderer as StreamingRenderer,
        autoInsertAfterResponse,
        plugin
      );
    }

  } catch (error) {
    await renderer.flush();
    assistantBubble.bodyEl.removeClass("is-streaming");

    if (isAbortError(error)) {
      if (editMode && renderer instanceof EditStreamingRenderer) {
        // In edit mode, still try to finalize any complete blocks on abort
        await finalizeEditResponse({
          app: plugin.app,
          owner,
          store,
          transcript,
          bubble: assistantBubble,
          renderer,
          plugin,
        });
      } else {
        await finalizeAbortedResponse(store, transcript, assistantBubble, renderer as StreamingRenderer);
      }
    } else {
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

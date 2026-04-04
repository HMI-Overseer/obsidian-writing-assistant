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
import { validateSendRequest } from "./validateSendRequest";
import { prepareApiMessages } from "./prepareApiMessages";
import { StreamingRenderer } from "./StreamingRenderer";
import { EditStreamingRenderer } from "./EditStreamingRenderer";
import { finalizeResponse, finalizeAbortedResponse } from "./finalizeResponse";
import { finalizeEditResponse } from "./finalizeEditResponse";
import { estimateTokenCount } from "../../shared/tokenEstimation";
import { CONTEXT_DANGER_THRESHOLD } from "../../constants";

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
  onCalibrate?: (estimatedTokens: number, actualTokens: number) => void;
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
    onCalibrate,
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
    ragService: plugin.ragService,
  });

  const ragSources = apiMessages.ragContext?.map(({ filePath, headingPath, score, content }) =>
    ({ filePath, headingPath, score, content })
  );

  // Attach Anthropic cache settings if enabled on the active model.
  if (activeModel.anthropicCacheSettings?.enabled) {
    apiMessages.anthropicCacheSettings = activeModel.anthropicCacheSettings;
  }

  await store.persistActiveConversation();

  const assistantBubble = transcript.createBubble("assistant");
  assistantBubble.bodyEl.addClass("is-streaming");

  const renderer = editMode
    ? new EditStreamingRenderer(assistantBubble, transcript)
    : new StreamingRenderer(assistantBubble, transcript);

  // Pre-send context capacity check.
  const contextWindow = activeModel.contextWindowSize
    ?? plugin.modelAvailability.getActiveContextLength(activeModel.modelId);
  if (contextWindow) {
    const estimatedTokens = estimateTokenCount(apiMessages);
    if (estimatedTokens / contextWindow >= CONTEXT_DANGER_THRESHOLD) {
      const pct = Math.round((estimatedTokens / contextWindow) * 100);
      new Notice(`Context is ~${pct}% full. The model may truncate older messages.`);
    }
  }

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
      await finalizeResponse(
        store,
        transcript,
        assistantBubble,
        renderer as StreamingRenderer,
        autoInsertAfterResponse,
        plugin,
        activeModel.modelId,
        activeModel.provider,
        usage,
        ragSources
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
          modelId: activeModel.modelId,
          provider: activeModel.provider,
        });
      } else {
        await finalizeAbortedResponse(store, transcript, assistantBubble, renderer as StreamingRenderer,
          activeModel.modelId, activeModel.provider, ragSources);
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

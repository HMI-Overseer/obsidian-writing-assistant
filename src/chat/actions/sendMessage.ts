import { Notice } from "obsidian";
import { LMStudioClient } from "../../api";
import { getActiveNoteContext } from "../../context/noteContext";
import type LMStudioWritingAssistant from "../../main";
import type { Message } from "../../shared/types";
import type { ChatComposer } from "../composer/ChatComposer";
import { makeMessage } from "../conversation/conversationUtils";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";
import type { ChatTranscript } from "../messages/ChatTranscript";
import type { ChatModelSelector } from "../models/ChatModelSelector";

const STREAMING_MARKDOWN_RENDER_DEBOUNCE_MS = 80;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Unknown error";
}

async function insertLastResponse(
  plugin: LMStudioWritingAssistant,
  lastAssistantResponse: string
): Promise<void> {
  if (!lastAssistantResponse) return;

  const editor = plugin.app.workspace.activeEditor?.editor;
  if (editor) {
    const selection = editor.getSelection();
    if (selection) {
      editor.replaceSelection(lastAssistantResponse);
    } else {
      const cursor = editor.getCursor("to");
      editor.replaceRange(`\n\n${lastAssistantResponse}`, cursor);
    }
    new Notice("Response inserted into note.");
    return;
  }

  const file = plugin.app.workspace.getActiveFile();
  if (file) {
    const content = await plugin.app.vault.read(file);
    await plugin.app.vault.modify(file, `${content}\n\n${lastAssistantResponse}`);
    new Notice("Response appended to note.");
    return;
  }

  new Notice("No active note to insert into.");
}

type SendMessageOptions = {
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

  if (getIsGenerating() || modelSelector.isCheckingStatus()) return;

  const text = (promptOverride ?? composer.getDraft()).trim();
  if (!text) return;

  const activeModel = store.getResolvedConversationModel();
  if (!activeModel?.modelId) {
    new Notice(
      "No model selected. Choose a saved profile in the chat selector or add one in Settings."
    );
    return;
  }

  const availabilityState = await modelSelector.refreshAvailability();
  if (availabilityState !== "loaded") {
    modelSelector.retriggerAttention();
    return;
  }

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

  let systemContent = activeModel.systemPrompt;
  if (
    plugin.settings.includeNoteContext &&
    composer.isSessionContextEnabled()
  ) {
    const context = await getActiveNoteContext(
      plugin.app,
      plugin.settings.maxContextChars
    );
    if (context) {
      systemContent += context;
    }
  }

  const apiMessages: Message[] = [
    { role: "system", content: systemContent },
    ...store.getSnapshot().messageHistory.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  ];

  await store.persistActiveConversation();

  const assistantBubble = transcript.createBubble("assistant");
  assistantBubble.bodyEl.addClass("is-streaming");
  let fullResponse = "";
  let hasStreamRenderedMarkdown = false;
  let lastRenderedStreamingText = "";
  let queuedStreamingText = "";
  let streamingRenderTimer: number | null = null;
  let streamingRenderChain = Promise.resolve();

  const queueStreamingMarkdownRender = (): void => {
    queuedStreamingText = fullResponse;
    if (streamingRenderTimer !== null) return;

    streamingRenderTimer = window.setTimeout(() => {
      streamingRenderTimer = null;
      streamingRenderChain = streamingRenderChain
        .then(async () => {
          const textToRender = queuedStreamingText;
          if (
            !textToRender ||
            textToRender === lastRenderedStreamingText ||
            !assistantBubble.contentEl.isConnected
          ) {
            return;
          }

          await transcript.renderBubbleContent(assistantBubble, textToRender, {
            preserveStreaming: true,
          });
          hasStreamRenderedMarkdown = true;
          lastRenderedStreamingText = textToRender;
          transcript.scrollToBottom();
        })
        .catch(() => undefined);
    }, STREAMING_MARKDOWN_RENDER_DEBOUNCE_MS);
  };

  const flushStreamingMarkdownRender = async (): Promise<void> => {
    if (streamingRenderTimer !== null) {
      window.clearTimeout(streamingRenderTimer);
      streamingRenderTimer = null;
    }

    streamingRenderChain = streamingRenderChain
      .then(async () => {
        const textToRender = queuedStreamingText;
        if (
          !textToRender ||
          textToRender === lastRenderedStreamingText ||
          !assistantBubble.contentEl.isConnected
        ) {
          return;
        }

        await transcript.renderBubbleContent(assistantBubble, textToRender, {
          preserveStreaming: true,
        });
        hasStreamRenderedMarkdown = true;
        lastRenderedStreamingText = textToRender;
        transcript.scrollToBottom();
      })
      .catch(() => undefined);

    await streamingRenderChain;
  };

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
      fullResponse += delta;
      if (!hasStreamRenderedMarkdown) {
        transcript.renderPlainTextContent(assistantBubble, fullResponse);
      }
      queueStreamingMarkdownRender();
      transcript.scrollToBottom();
    }

    await flushStreamingMarkdownRender();
    assistantBubble.bodyEl.removeClass("is-streaming");

    if (fullResponse) {
      const assistantMessage = makeMessage("assistant", fullResponse);
      store.appendMessage(assistantMessage);
      store.setLastAssistantResponse(fullResponse);
      if (
        !hasStreamRenderedMarkdown ||
        lastRenderedStreamingText !== fullResponse
      ) {
        await transcript.renderBubbleContent(assistantBubble, fullResponse);
      }

      if (autoInsertAfterResponse) {
        await insertLastResponse(plugin, fullResponse);
      }
    } else {
      transcript.renderPlainTextContent(assistantBubble, "(no response)");
    }

    setStatus("Ready", true);
  } catch (error) {
    await flushStreamingMarkdownRender();
    assistantBubble.bodyEl.removeClass("is-streaming");

    if (isAbortError(error)) {
      if (fullResponse) {
        const assistantMessage = makeMessage("assistant", fullResponse);
        store.appendMessage(assistantMessage);
        store.setLastAssistantResponse(fullResponse);
        if (
          !hasStreamRenderedMarkdown ||
          lastRenderedStreamingText !== fullResponse
        ) {
          await transcript.renderBubbleContent(assistantBubble, fullResponse);
        }
      } else {
        transcript.renderPlainTextContent(assistantBubble, "Generation stopped.");
        assistantBubble.bodyEl.addClass("is-muted");
      }

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
  }
}

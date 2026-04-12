import type { Component } from "obsidian";
import { createChatClient } from "../../providers/registry";
import type WritingAssistantChat from "../../main";
import type { ChatComposer } from "../composer/ChatComposer";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";
import type { ChatTranscript } from "../messages/ChatTranscript";
import type { ChatModelSelector } from "../models/ChatModelSelector";
import { makeMessage } from "../conversation/conversationUtils";
import { validateSendRequest } from "./validateSendRequest";
import { generateLlmResponse } from "./generateLlmResponse";

export type SendMessageOptions = {
  plugin: WritingAssistantChat;
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
    promptOverride,
  );
  if (!validated) return;

  const { text, activeModel } = validated;

  // Reject any pending hunks from previous edit proposals.
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
  const userBubble = transcript.createBubble("user", userMessage.id);
  await transcript.renderBubbleContent(userBubble, text);
  transcript.trackManualBubble(userMessage.id, userBubble);
  store.appendMessage(userMessage);
  transcript.setEmptyStateVisible(false);

  const client = createChatClient(activeModel.provider, plugin.settings.providerSettings);

  await generateLlmResponse({
    plugin,
    owner,
    store,
    transcript,
    composer,
    activeModel,
    client,
    editMode,
    finalization: { kind: "append", autoInsert: autoInsertAfterResponse },
    setIsGenerating,
    setActiveAbortController,
    syncConversationUi,
    onCalibrate,
  });
}

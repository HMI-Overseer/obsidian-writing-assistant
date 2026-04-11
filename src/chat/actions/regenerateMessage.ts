import type { Component } from "obsidian";
import { Notice } from "obsidian";
import { createChatClient } from "../../providers/registry";
import type WritingAssistantChat from "../../main";
import type { ChatComposer } from "../composer/ChatComposer";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";
import type { ChatTranscript } from "../messages/ChatTranscript";
import type { ChatModelSelector } from "../models/ChatModelSelector";
import { generateLlmResponse } from "./generateLlmResponse";

export type RegenerateOptions = {
  plugin: WritingAssistantChat;
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
    finalization: { kind: "replace", oldMessage },
    setIsGenerating,
    setActiveAbortController,
    syncConversationUi,
    onCalibrate,
  });
}

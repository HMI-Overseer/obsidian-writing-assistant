import type { Component } from "obsidian";
import { Notice } from "obsidian";
import type { ConversationMessage } from "../shared/types";
import type WritingAssistantChat from "../main";
import { createChatClient } from "../providers/registry";
import type { ChatComposer } from "./composer/ChatComposer";
import type { ChatSessionStore } from "./conversation/ChatSessionStore";
import type { ContextCapacityUpdater } from "./ContextCapacityUpdater";
import type { ChatTranscript } from "./messages/ChatTranscript";
import type { ChatModelSelector } from "./models/ChatModelSelector";
import type { ChatLayoutRefs } from "./types";
import { sendMessage } from "./actions/sendMessage";
import { generateLlmResponse } from "./actions/generateLlmResponse";
import { regenerateMessage } from "./actions/regenerateMessage";

export type GenerationOrchestratorDeps = {
  plugin: WritingAssistantChat;
  owner: Component;
  getStore: () => ChatSessionStore | null;
  getTranscript: () => ChatTranscript | null;
  getComposer: () => ChatComposer | null;
  getModelSelector: () => ChatModelSelector | null;
  getContextUpdater: () => ContextCapacityUpdater | null;
  getLayout: () => ChatLayoutRefs | null;
  syncConversationUi: () => Promise<void>;
  postGenerationSync: () => Promise<void>;
};

export class ChatGenerationOrchestrator {
  private isGenerating = false;
  private activeAbortController: AbortController | null = null;

  constructor(private readonly deps: GenerationOrchestratorDeps) {}

  getIsGenerating(): boolean {
    return this.isGenerating;
  }

  setIsGenerating(generating: boolean): void {
    this.isGenerating = generating;
    this.deps.getComposer()?.setSendingState(generating);

    const snapshot = this.deps.getStore()?.getSnapshot();
    this.deps.getTranscript()?.setEmptyStateVisible(
      Boolean(snapshot && snapshot.messageHistory.length === 0 && !generating)
    );
  }

  stopGeneration(): void {
    if (!this.activeAbortController) return;
    this.activeAbortController.abort();
    this.activeAbortController = null;
  }

  async send(
    promptOverride?: string,
    autoInsertAfterResponse = false,
  ): Promise<void> {
    const store = this.deps.getStore();
    const transcript = this.deps.getTranscript();
    const composer = this.deps.getComposer();
    const modelSelector = this.deps.getModelSelector();
    if (!store || !transcript || !composer || !modelSelector) return;

    const useEditMode = composer.getMode() === "edit";

    await sendMessage({
      plugin: this.deps.plugin,
      owner: this.deps.owner,
      store,
      transcript,
      composer,
      modelSelector,
      getIsGenerating: () => this.isGenerating,
      setIsGenerating: (sending) => this.setIsGeneratingAndSync(sending),
      setActiveAbortController: (controller) => {
        this.activeAbortController = controller;
      },
      syncConversationUi: () => this.deps.syncConversationUi(),
      onCalibrate: (est, actual) => this.deps.getContextUpdater()?.calibrate(est, actual),
      promptOverride,
      autoInsertAfterResponse,
      editMode: useEditMode,
    });
    await this.deps.postGenerationSync();
  }

  async regenerate(messageId: string): Promise<void> {
    const store = this.deps.getStore();
    const transcript = this.deps.getTranscript();
    const composer = this.deps.getComposer();
    const modelSelector = this.deps.getModelSelector();
    if (!store || !transcript || !composer || !modelSelector) return;

    await regenerateMessage({
      plugin: this.deps.plugin,
      owner: this.deps.owner,
      store,
      transcript,
      composer,
      modelSelector,
      messageId,
      getIsGenerating: () => this.isGenerating,
      setIsGenerating: (generating) => this.setIsGeneratingAndSync(generating),
      setActiveAbortController: (controller) => {
        this.activeAbortController = controller;
      },
      syncConversationUi: () => this.deps.syncConversationUi(),
      onCalibrate: (est, actual) => this.deps.getContextUpdater()?.calibrate(est, actual),
    });
    await this.deps.postGenerationSync();
  }

  async generateResponse(): Promise<void> {
    const store = this.deps.getStore();
    const transcript = this.deps.getTranscript();
    const composer = this.deps.getComposer();
    const modelSelector = this.deps.getModelSelector();
    if (!store || !transcript || !composer || !modelSelector) return;
    if (this.isGenerating) return;

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
      await this.deps.syncConversationUi();
    }

    if (store.getSnapshot().messageHistory.length === 0) return;

    const editMode = composer.getMode() === "edit";
    const client = createChatClient(activeModel.provider, this.deps.plugin.settings.providerSettings);

    this.setIsGeneratingAndSync(true);

    await generateLlmResponse({
      plugin: this.deps.plugin,
      owner: this.deps.owner,
      store,
      transcript,
      composer,
      activeModel,
      client,
      editMode,
      finalization: { kind: "append" },
      setIsGenerating: (v) => this.setIsGeneratingAndSync(v),
      setActiveAbortController: (c) => {
        this.activeAbortController = c;
      },
      onCalibrate: (est, actual) => this.deps.getContextUpdater()?.calibrate(est, actual),
    });
    await this.deps.postGenerationSync();
  }

  private setIsGeneratingAndSync(generating: boolean): void {
    this.setIsGenerating(generating);
    const messages = this.deps.getStore()?.getSnapshot().messageHistory ?? [];
    this.updateGenerateResponseButton(messages);
  }

  updateGenerateResponseButton(messages: ConversationMessage[]): void {
    const btn = this.deps.getLayout()?.generateResponseBtn;
    if (!btn) return;

    const shouldShow =
      !this.isGenerating &&
      messages.length > 0 &&
      (messages[messages.length - 1].role === "user" ||
        messages[messages.length - 1].isError === true);

    btn.toggleClass("lmsa-hidden", !shouldShow);
  }
}

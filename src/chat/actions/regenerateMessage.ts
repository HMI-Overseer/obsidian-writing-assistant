import type { Component } from "obsidian";
import { Notice } from "obsidian";
import { createChatClient } from "../../providers/registry";
import type WritingAssistantChat from "../../main";
import type { ChatComposer } from "../composer/ChatComposer";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";
import type { ChatTranscript } from "../messages/ChatTranscript";
import type { ChatModelSelector } from "../models/ChatModelSelector";
import type { ComposerInteractionHostPort } from "../interactions/ComposerInteractionHost";
import { generateLlmResponse } from "./generateLlmResponse";

export type RegenerateOptions = {
  plugin: WritingAssistantChat;
  owner: Component;
  store: ChatSessionStore;
  transcript: ChatTranscript;
  composer: ChatComposer;
  modelSelector: ChatModelSelector;
  interactionHost: ComposerInteractionHostPort;
  messageId: string;
  getIsGenerating: () => boolean;
  setIsGenerating: (generating: boolean) => void;
  setActiveAbortController: (controller: AbortController | null) => void;
  syncConversationUi: () => Promise<void>;
  onCalibrate?: (estimatedTokens: number, actualTokens: number) => void;
  onEnterAutoApply?: () => void;
};

export async function regenerateMessage(options: RegenerateOptions): Promise<void> {
  const {
    plugin,
    owner,
    store,
    transcript,
    composer,
    modelSelector,
    interactionHost,
    messageId,
    getIsGenerating,
    setIsGenerating,
    setActiveAbortController,
    onCalibrate,
    onEnterAutoApply,
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

  const posture = composer.getPosture();

  const oldMessage = lastMessage;

  setIsGenerating(true);

  // Keep the original revision and ledger active while an ephemeral replacement
  // draft streams. Generation commits the replacement atomically when meaningful.

  const runtime = await plugin.services.claudeCode.getRuntime(activeModel.provider, {
    posture,
    activeFilePath: plugin.app.workspace.getActiveFile()?.path,
    conversationId: store.getActiveConversationId() ?? undefined,
    // Regenerate rewinds the transcript, so the resume gate rejects this cursor and
    // the turn synthetically rebuilds; passed for a uniform recovery path.
    resumeCursor: store.getClaudeCodeResumeCursor(),
    contextWindow: plugin.services.modelAvailability.resolveContextWindow(activeModel),
  });
  const client = createChatClient(
    activeModel.provider,
    plugin.settings.providerSettings,
    plugin.services.credentials,
    runtime,
  );

  await generateLlmResponse({
    plugin,
    owner,
    store,
    transcript,
    activeModel,
    client,
    interactionHost,
    posture,
    ...(runtime?.generation ? { claudeGeneration: runtime.generation } : {}),
    finalization: { kind: "replace", oldMessage },
    setIsGenerating,
    setActiveAbortController,
    onCalibrate,
    onEnterAutoApply,
  });
}

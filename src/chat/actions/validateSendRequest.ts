import { Notice } from "obsidian";
import type { CompletionModel } from "../../shared/types";
import type { ChatComposer } from "../composer/ChatComposer";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";
import type { ChatModelSelector } from "../models/ChatModelSelector";

export type ValidatedSendContext = {
  text: string;
  activeModel: CompletionModel;
};

export async function validateSendRequest(
  store: ChatSessionStore,
  composer: ChatComposer,
  modelSelector: ChatModelSelector,
  isGenerating: boolean,
  promptOverride?: string
): Promise<ValidatedSendContext | null> {
  if (isGenerating || modelSelector.isCheckingStatus()) return null;

  const text = (promptOverride ?? composer.getDraft()).trim();
  if (!text) return null;

  const activeModel = store.getResolvedConversationModel();
  if (!activeModel?.modelId) {
    new Notice(
      "No model selected. Choose a saved profile in the chat selector or add one in Settings."
    );
    return null;
  }

  const availabilityState = await modelSelector.refreshAvailability();
  if (availabilityState !== "loaded" && availabilityState !== "cloud") {
    modelSelector.retriggerAttention();
    return null;
  }

  return { text, activeModel };
}

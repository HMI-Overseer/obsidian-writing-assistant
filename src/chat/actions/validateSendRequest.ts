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
  if (isGenerating) return null;
  if (modelSelector.isCheckingStatus()) {
    new Notice("Checking model status, try again in a moment.");
    return null;
  }

  const text = (promptOverride ?? composer.getDraft()).trim();
  const hasAttachments = composer.getAttachments().length > 0;
  if (!text && !hasAttachments) return null;

  const activeModel = store.getResolvedConversationModel();
  if (!activeModel?.modelId) {
    new Notice(
      "No model selected. Choose a saved profile in the chat selector or add one in settings."
    );
    return null;
  }

  if (hasAttachments && !composer.canAttachImages()) {
    new Notice(
      "The active model does not support image input. Remove attachments or switch to a vision-capable model."
    );
    return null;
  }

  const availabilityState = await modelSelector.refreshAvailability();
  if (availabilityState !== "loaded" && availabilityState !== "cloud") {
    modelSelector.retriggerAttention();
    new Notice(
      availabilityState === "unloaded"
        ? "Model not loaded. Start LM Studio and load the model, or pick another profile."
        : "Could not reach the model. Make sure the local server (e.g. LM Studio) is running, or pick another profile."
    );
    return null;
  }

  return { text, activeModel };
}

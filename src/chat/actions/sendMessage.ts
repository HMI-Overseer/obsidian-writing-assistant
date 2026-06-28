import type { Component } from "obsidian";
import { createChatClient } from "../../providers/registry";
import type { ApprovalPosture } from "../../shared/types";
import type WritingAssistantChat from "../../main";
import type { ChatComposer } from "../composer/ChatComposer";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";
import type { ChatTranscript } from "../messages/ChatTranscript";
import type { ChatModelSelector } from "../models/ChatModelSelector";
import { makeMessage } from "../conversation/conversationUtils";
import { validateSendRequest } from "./validateSendRequest";
import { generateLlmResponse } from "./generateLlmResponse";
import { supersedePriorProposals } from "./supersedePriorProposals";
import { snapshotNoteAttachments } from "../../context/noteAttachment";

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
  posture: ApprovalPosture;
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
    posture,
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

  // A new user turn supersedes every prior proposal (both channels): pending work
  // is rejected (interjection = implicit rejection) and applied vault batches go
  // historical. See supersedePriorProposals, scoped to this user-message boundary.
  const history = store.getSnapshot().messageHistory;
  if (supersedePriorProposals(history)) {
    await store.persistActiveConversation();
    await syncConversationUi();
  }

  const pendingAttachments = composer.getAttachments();

  // Freeze the attached notes (and their embedded images) into a point-in-time
  // snapshot bound to this user turn, so they stay cache-stable in history instead
  // of being re-read into the prefix every send. There is no live document re-read
  // anymore (ambient editing, §6.3/§10/§13); the model reads current content via
  // tools when it edits.
  const supportsVision =
    validated.activeModel.vision
    ?? plugin.services.modelAvailability.getVision(validated.activeModel.modelId)
    ?? false;
  const noteAttachments = await snapshotNoteAttachments(plugin.app, {
    activeNoteAttached: composer.isActiveNoteAttached(),
    extraContextItems: composer.getExtraContextItems(),
    maxContextChars: plugin.settings.maxContextChars,
    includeImages: plugin.settings.includeLocalAttachmentsAsContext && supportsVision,
  });

  composer.clearDraft();
  composer.clearAttachments();
  composer.clearAttachedNotes();
  store.setDraft("");
  setIsGenerating(true);

  if (store.ensureConversationTitleFromFirstUserMessage(text)) {
    await syncConversationUi();
  }

  const userMessage = makeMessage("user", text);
  const allAttachments = [...pendingAttachments, ...noteAttachments];
  if (allAttachments.length > 0) {
    userMessage.attachments = allAttachments;
  }
  const userBubble = transcript.createBubble("user", userMessage.id);
  await transcript.renderBubbleContent(userBubble, text, { attachments: userMessage.attachments });
  store.appendMessage(userMessage);
  transcript.setEmptyStateVisible(false);

  const client = createChatClient(
    activeModel.provider,
    plugin.settings.providerSettings,
    await plugin.services.claudeCode.getRuntime(activeModel.provider, {
      posture,
      activeFilePath: plugin.app.workspace.getActiveFile()?.path,
      conversationId: store.getActiveConversationId() ?? undefined,
    }),
  );

  await generateLlmResponse({
    plugin,
    owner,
    store,
    transcript,
    activeModel,
    client,
    posture,
    finalization: { kind: "append", autoInsert: autoInsertAfterResponse },
    setIsGenerating,
    setActiveAbortController,
    onCalibrate,
  });
}

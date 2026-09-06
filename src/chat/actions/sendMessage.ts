import type { Component } from "obsidian";
import { createChatClient } from "../../providers/registry";
import { resolveVisionSupport } from "../../api/ModelAvailabilityService";
import type { ApprovalPosture } from "../../shared/types";
import type WritingAssistantChat from "../../main";
import type { ChatComposer } from "../composer/ChatComposer";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";
import type { ChatTranscript } from "../messages/ChatTranscript";
import type { ChatModelSelector } from "../models/ChatModelSelector";
import type { ComposerInteractionHostPort } from "../interactions/ComposerInteractionHost";
import { makeMessage } from "../conversation/conversationUtils";
import { validateSendRequest } from "./validateSendRequest";
import { generateLlmResponse } from "./generateLlmResponse";
import { snapshotNoteAttachments } from "../../context/noteAttachment";

export type SendMessageOptions = {
  plugin: WritingAssistantChat;
  owner: Component;
  store: ChatSessionStore;
  transcript: ChatTranscript;
  composer: ChatComposer;
  modelSelector: ChatModelSelector;
  interactionHost: ComposerInteractionHostPort;
  getIsGenerating: () => boolean;
  setIsGenerating: (sending: boolean) => void;
  setActiveAbortController: (controller: AbortController | null) => void;
  syncConversationUi: () => Promise<void>;
  onCalibrate?: (estimatedTokens: number, actualTokens: number) => void;
  onEnterAutoApply?: () => void;
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
    interactionHost,
    getIsGenerating,
    setIsGenerating,
    setActiveAbortController,
    syncConversationUi,
    onCalibrate,
    onEnterAutoApply,
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

  const pendingAttachments = composer.getAttachments();

  // Freeze the attached notes (and their embedded images) into a point-in-time
  // snapshot bound to this user turn, so they stay cache-stable in history instead
  // of being re-read into the prefix every send. There is no live document re-read
  // anymore under ambient editing; the model reads current content via
  // tools when it edits.
  // Kept as the tri-state the resolver returns: the note-image gate below reads unknown
  // as allow-the-attempt (mirrors the composer attach gate), so an unprobed model's image
  // rides the turn instead of being silently dropped, while the Claude Code runtime wants
  // the raw answer so its delivery flag can tell unknown from a known "cannot see".
  const visionSupport = resolveVisionSupport(
    validated.activeModel,
    plugin.services.modelAvailability,
  );
  const noteAttachments = await snapshotNoteAttachments(plugin.app, {
    activeNoteAttached: composer.isActiveNoteAttached(),
    extraContextItems: composer.getExtraContextItems(),
    maxContextChars: plugin.settings.maxContextChars,
    includeImages:
      plugin.settings.includeLocalAttachmentsAsContext && (visionSupport ?? true),
  });

  composer.clearDraft();
  composer.clearAttachments();
  composer.clearAttachedNotes();
  store.setDraft("");
  // A draft that has just been sent is not a draft, and the save armed by the last keystroke would
  // otherwise land in the middle of this turn's own writes. Storage serialises them now, so this is
  // no longer a correctness fix; it is one fewer pointless write of a draft that is already empty.
  store.clearDraftSaveTimer();
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

  const runtime = await plugin.services.claudeCode.getRuntime(activeModel.provider, {
    posture,
    activeFilePath: plugin.app.workspace.getActiveFile()?.path,
    conversationId: store.getActiveConversationId() ?? undefined,
    resumeCursor: store.getClaudeCodeResumeCursor(),
    contextWindow: plugin.services.modelAvailability.resolveContextWindow(activeModel),
    ...(visionSupport === undefined ? {} : { supportsVision: visionSupport }),
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
    finalization: { kind: "append", autoInsert: autoInsertAfterResponse },
    setIsGenerating,
    setActiveAbortController,
    onCalibrate,
    onEnterAutoApply,
  });
}

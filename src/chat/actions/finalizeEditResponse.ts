import { type App, type Component, Notice } from "obsidian";
import { parseEditBlocks } from "../../editing/parseEditBlocks";
import { resolveEdits, buildHunks } from "../../editing/diffEngine";
import type { EditProposal, AppliedEditRecord } from "../../editing/editTypes";
import { generateId } from "../../utils";
import { makeMessage } from "../conversation/conversationUtils";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";
import type { ChatTranscript } from "../messages/ChatTranscript";
import { DiffReviewPanel } from "../messages/DiffReviewPanel";
import type { BubbleRefs } from "../types";
import type { EditStreamingRenderer } from "./EditStreamingRenderer";
import type LMStudioWritingAssistant from "../../main";

export interface FinalizeEditOptions {
  app: App;
  owner: Component;
  store: ChatSessionStore;
  transcript: ChatTranscript;
  bubble: BubbleRefs;
  renderer: EditStreamingRenderer;
  plugin: LMStudioWritingAssistant;
}

/**
 * Post-generation handler for edit mode.
 *
 * Parses the model's response for search/replace blocks, resolves them
 * against the active document, and renders a DiffReviewPanel if blocks
 * are found. Falls back to normal message rendering if no blocks are present.
 */
export async function finalizeEditResponse(options: FinalizeEditOptions): Promise<void> {
  const { app, owner, store, transcript, bubble, renderer, plugin } = options;

  const fullResponse = renderer.getFullResponse();
  if (!fullResponse) {
    transcript.renderPlainTextContent(bubble, "(no response)");
    return;
  }

  const file = app.workspace.getActiveFile();
  if (!file) {
    // No active file — fall back to normal rendering
    await renderAsNormalMessage(store, transcript, bubble, fullResponse);
    return;
  }

  const { blocks, prose } = parseEditBlocks(fullResponse);

  if (blocks.length === 0) {
    if (fullResponse.includes("<<<SEARCH")) {
      new Notice("Edit blocks were detected but couldn't be parsed.");
    }
    await renderAsNormalMessage(store, transcript, bubble, fullResponse);
    return;
  }

  // Read the full document for resolution
  const documentText = await app.vault.read(file);

  const resolvedEdits = resolveEdits(blocks, documentText, {
    contextLines: plugin.settings.diffContextLines,
    minConfidence: plugin.settings.diffMinMatchConfidence,
  });
  const hunks = buildHunks(resolvedEdits);

  const proposal: EditProposal = {
    id: generateId(),
    targetFilePath: file.path,
    documentSnapshot: documentText,
    snapshotTimestamp: Date.now(),
    hunks,
    prose,
  };

  // Save message with the proposal attached
  const assistantMessage = makeMessage("assistant", fullResponse);
  assistantMessage.editProposal = proposal;
  store.appendMessage(assistantMessage);
  store.setLastAssistantResponse(fullResponse);

  // Render the DiffReviewPanel in the bubble
  renderDiffPanel(app, owner, store, bubble, proposal);
}

/**
 * Render a DiffReviewPanel into an existing bubble.
 * Used both during finalization and when re-rendering historical messages.
 */
export function renderDiffPanel(
  app: App,
  owner: Component,
  store: ChatSessionStore,
  bubble: BubbleRefs,
  proposal: EditProposal,
  existingRecord?: AppliedEditRecord
): void {
  bubble.contentEl.empty();
  bubble.contentEl.removeClass("lmsa-message-content--plain", "lmsa-message-content--markdown");

  new DiffReviewPanel(bubble.contentEl, app, owner, proposal, {
    onHunksChanged: (updatedProposal) => {
      // Persist hunk status changes to conversation store
      const messages = store.getSnapshot().messageHistory;
      const msg = messages.find((m) => m.editProposal?.id === updatedProposal.id);
      if (msg) {
        msg.editProposal = updatedProposal;
        store.persistActiveConversation();
      }
    },
    onApplied: (record) => {
      const messages = store.getSnapshot().messageHistory;
      const msg = messages.find((m) => m.editProposal?.id === proposal.id);
      if (msg) {
        msg.appliedEdit = record;
        store.persistActiveConversation();
      }
    },
    onUndone: () => {
      const messages = store.getSnapshot().messageHistory;
      const msg = messages.find((m) => m.editProposal?.id === proposal.id);
      if (msg) {
        msg.appliedEdit = undefined;
        store.persistActiveConversation();
      }
    },
  }, existingRecord);
}

async function renderAsNormalMessage(
  store: ChatSessionStore,
  transcript: ChatTranscript,
  bubble: BubbleRefs,
  fullResponse: string
): Promise<void> {
  const assistantMessage = makeMessage("assistant", fullResponse);
  store.appendMessage(assistantMessage);
  store.setLastAssistantResponse(fullResponse);
  await transcript.renderBubbleContent(bubble, fullResponse);
}

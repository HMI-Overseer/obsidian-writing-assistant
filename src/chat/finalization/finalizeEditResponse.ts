import { type App, type Component, Notice } from "obsidian";
import { parseEditBlocks } from "../../editing/parseEditBlocks";
import { toolCallsToEditBlocks } from "../../tools/editing/conversion";
import { resolveStructuralEditBlocks } from "../../tools/editing/handlers";
import { resolveEdits, buildHunks } from "../../editing/diffEngine";
import type { EditBlock, EditProposal, AppliedEditRecord } from "../../editing/editTypes";
import { generateId } from "../../utils";
import { makeMessage } from "../conversation/conversationUtils";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";
import type { ChatTranscript } from "../messages/ChatTranscript";
import { DiffReviewPanel } from "../messages/DiffReviewPanel";
import type { BubbleRefs } from "../types";
import type { EditStreamingRenderer } from "../streaming/EditStreamingRenderer";
import type WritingAssistantChat from "../../main";
import type { AgenticStep, ProviderOption } from "../../shared/types";
import type { ToolCall } from "../../tools/types";
import type { UsageResult } from "../../api/usageTypes";
import { attachUsageToMessage } from "./finalizeResponse";

export interface FinalizeEditOptions {
  app: App;
  owner: Component;
  store: ChatSessionStore;
  transcript: ChatTranscript;
  bubble: BubbleRefs;
  renderer: EditStreamingRenderer;
  plugin: WritingAssistantChat;
  modelId?: string;
  provider?: ProviderOption;
  usage?: UsageResult | null;
  /** Tool calls from the stream result. When present, uses tool-call extraction instead of regex parsing. */
  toolCalls?: ToolCall[] | null;
  /** Agentic step timeline from the tool loop. Attached to the saved message; never sent to the API. */
  agenticSteps?: AgenticStep[];
}

/**
 * Post-generation handler for edit mode.
 *
 * Parses the model's response for search/replace blocks, resolves them
 * against the active document, and renders a DiffReviewPanel if blocks
 * are found. Falls back to normal message rendering if no blocks are present.
 */
export async function finalizeEditResponse(options: FinalizeEditOptions): Promise<void> {
  const { app, owner, store, transcript, bubble, renderer, plugin, modelId, provider, usage, toolCalls, agenticSteps } = options;

  const fullResponse = renderer.getFullResponse();
  if (!fullResponse && (!toolCalls || toolCalls.length === 0)) {
    transcript.renderPlainTextContent(bubble, "(no response)");
    return;
  }

  const file = app.workspace.getActiveFile();
  if (!file) {
    await renderAsNormalMessage(store, transcript, bubble, fullResponse || "", modelId, provider, usage, agenticSteps);
    return;
  }

  // Dual path: tool calls vs regex parsing.
  let blocks: EditBlock[];
  let prose: string;

  if (toolCalls && toolCalls.length > 0) {
    blocks = toolCallsToEditBlocks(toolCalls);
    prose = fullResponse;  // Text content IS the prose (no blocks embedded).
  } else {
    const parsed = parseEditBlocks(fullResponse);
    blocks = parsed.blocks;
    prose = parsed.prose;
  }

  if (blocks.length === 0) {
    if (fullResponse.includes("<<<SEARCH")) {
      new Notice("Edit blocks were detected but couldn't be parsed.");
    }
    await renderAsNormalMessage(store, transcript, bubble, fullResponse, modelId, provider, usage, agenticSteps);
    return;
  }

  // Resolve structural edit blocks (replace_section, insert_at_position, update_frontmatter)
  // that need MetadataCache or document content to populate searchText/replaceText.
  const hasStructuralBlocks = blocks.some((b) => b.toolName);
  if (hasStructuralBlocks) {
    blocks = await resolveStructuralEditBlocks(blocks, { app, filePath: file.path });
  }

  // Read the full document for resolution.
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

  // Save message with the proposal attached.
  const assistantMessage = makeMessage("assistant", fullResponse);
  assistantMessage.editProposal = proposal;
  if (toolCalls && toolCalls.length > 0) {
    assistantMessage.toolCalls = toolCalls;
  }
  if (agenticSteps?.length) assistantMessage.agenticSteps = agenticSteps;
  attachUsageToMessage(assistantMessage, modelId, provider, usage);
  store.appendMessage(assistantMessage);
  store.setLastAssistantResponse(fullResponse);
  transcript.registerBubble(assistantMessage.id, bubble);

  // Render the DiffReviewPanel in the bubble.
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
        void store.persistActiveConversation();
      }
    },
    onApplied: (record) => {
      const messages = store.getSnapshot().messageHistory;
      const msg = messages.find((m) => m.editProposal?.id === proposal.id);
      if (msg) {
        msg.appliedEdit = record;
        void store.persistActiveConversation();
      }
    },
    onUndone: () => {
      const messages = store.getSnapshot().messageHistory;
      const msg = messages.find((m) => m.editProposal?.id === proposal.id);
      if (msg) {
        msg.appliedEdit = undefined;
        void store.persistActiveConversation();
      }
    },
  }, existingRecord);
}

async function renderAsNormalMessage(
  store: ChatSessionStore,
  transcript: ChatTranscript,
  bubble: BubbleRefs,
  fullResponse: string,
  modelId?: string,
  provider?: ProviderOption,
  usage?: UsageResult | null,
  agenticSteps?: AgenticStep[]
): Promise<void> {
  const assistantMessage = makeMessage("assistant", fullResponse);
  attachUsageToMessage(assistantMessage, modelId, provider, usage);
  if (agenticSteps?.length) assistantMessage.agenticSteps = agenticSteps;
  store.appendMessage(assistantMessage);
  store.setLastAssistantResponse(fullResponse);
  transcript.registerBubble(assistantMessage.id, bubble);
  await transcript.renderBubbleContent(bubble, fullResponse);
}

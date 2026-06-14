import {
  type App,
  type Component,
  type MetadataCache,
  type TFile,
  Notice,
  normalizePath,
} from "obsidian";
import { parseEditBlocks } from "../../editing/parseEditBlocks";
import { toolCallsToEditBlocks } from "../../tools/editing/conversion";
import { resolveStructuralEditBlocks } from "../../tools/editing/handlers";
import { resolveEdits, buildHunks } from "../../editing/diffEngine";
import type { EditBlock, EditProposal } from "../../editing/editTypes";
import { EDIT_TOOL_NAMES } from "../../tools/editing/definition";
import { VAULT_OPS_TOOL_NAMES } from "../../tools/vault-ops/definition";
import { toVaultOperations, type ConversionProbes } from "../../tools/vault-ops/conversion";
import { diskState, diskFingerprint, readContentOrNull } from "../../vault-ops/apply";
import { resolveGate, type VaultOpPolicy } from "../../vault-ops/gateway";
import { summarizeOp } from "../../vault-ops/summary";
import type {
  ReviewableVaultOp,
  VaultOperationProposal,
} from "../../vault-ops/types";
import { generateId } from "../../utils";
import { makeMessage } from "../conversation/conversationUtils";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";
import type { ChatTranscript } from "../messages/ChatTranscript";
import { DiffReviewPanel, type DiffPanelCallbacks } from "../messages/DiffReviewPanel";
import {
  VaultOperationReviewPanel,
  type VaultOpPanelCallbacks,
} from "../messages/VaultOperationReviewPanel";
import type { BubbleRefs } from "../types";
import type { EditStreamingRenderer } from "../streaming/EditStreamingRenderer";
import type WritingAssistantChat from "../../main";
import type { AgenticStep, ConversationMessage, ProviderOption } from "../../shared/types";
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
  /** True when generation stopped for max_tokens — arms the write_file truncation guard (spec §6 1a). */
  stoppedForMaxTokens?: boolean;
}

/**
 * Post-generation handler for edit mode.
 *
 * Partitions the model's write tool calls into two channels and renders up to two
 * review panels in the bubble (spec §6):
 *   - the **edit channel** (active-document-bound) → an {@link EditProposal} / DiffReviewPanel;
 *   - the **vault-op channel** (whole-vault) → a {@link VaultOperationProposal} /
 *     VaultOperationReviewPanel — needs no active file.
 *
 * Falls back to a plain message ONLY when both channels are empty — so a pure
 * file-ops turn (e.g. "create a new note" with no document open) is no longer
 * silently dropped, the bug the old no-active-file bail caused.
 */
export async function finalizeEditResponse(options: FinalizeEditOptions): Promise<void> {
  const {
    app, owner, store, transcript, bubble, renderer, plugin, modelId, provider, usage,
    toolCalls, agenticSteps, stoppedForMaxTokens,
  } = options;

  const fullResponse = renderer.getFullResponse();
  if (!fullResponse && (!toolCalls || toolCalls.length === 0)) {
    transcript.renderPlainTextContent(bubble, "(no response)");
    return;
  }

  const hasToolCalls = !!toolCalls && toolCalls.length > 0;
  const editCalls = hasToolCalls ? toolCalls.filter((tc) => EDIT_TOOL_NAMES.has(tc.name)) : [];
  const vaultOpCalls = hasToolCalls ? toolCalls.filter((tc) => VAULT_OPS_TOOL_NAMES.has(tc.name)) : [];

  // --- Edit channel: blocks from tool calls (edit tools only) or regex parsing. ---
  let blocks: EditBlock[];
  let prose: string;
  if (hasToolCalls) {
    blocks = toolCallsToEditBlocks(editCalls); // vault-op calls must NOT pass through here.
    prose = fullResponse;
  } else {
    const parsed = parseEditBlocks(fullResponse);
    blocks = parsed.blocks;
    prose = parsed.prose;
  }

  const file = app.workspace.getActiveFile();
  let editProposal: EditProposal | null = null;
  if (file && blocks.length > 0) {
    editProposal = await buildEditProposal(app, plugin, file.path, blocks, prose);
  }

  // --- Vault-op channel: builds a proposal with no active file required. ---
  // The prose belongs to the edit panel when both channels fire (so it never shows
  // twice); otherwise the vault-op panel renders it.
  let vaultOpProposal: VaultOperationProposal | null = null;
  if (vaultOpCalls.length > 0) {
    vaultOpProposal = await buildVaultOpProposal(
      app,
      vaultOpCalls,
      editProposal ? undefined : prose,
      stoppedForMaxTokens ?? false,
      plugin.settings.vaultOpPolicy,
    );
  }

  // Bail to a plain message ONLY when BOTH channels are empty.
  if (!editProposal && !vaultOpProposal) {
    if (!hasToolCalls && fullResponse.includes("<<<SEARCH")) {
      new Notice("Edit blocks were detected but couldn't be parsed.");
    }
    await renderAsNormalMessage(store, transcript, bubble, fullResponse, modelId, provider, usage, agenticSteps);
    return;
  }

  // Save the message with whichever proposals are present.
  const assistantMessage = makeMessage("assistant", fullResponse);
  if (editProposal) assistantMessage.editProposal = editProposal;
  if (vaultOpProposal) assistantMessage.vaultOpProposal = vaultOpProposal;
  if (hasToolCalls) assistantMessage.toolCalls = toolCalls;
  if (agenticSteps?.length) assistantMessage.agenticSteps = agenticSteps;
  attachUsageToMessage(assistantMessage, modelId, provider, usage);
  store.appendMessage(assistantMessage);
  store.setLastAssistantResponse(fullResponse);
  transcript.registerBubble(assistantMessage.id, bubble);

  // Render the review panel(s). Fresh finalization auto-applies auto-gated vault ops.
  renderProposalPanels(app, owner, store, bubble, assistantMessage, { autoApplyVaultOps: true });
}

/**
 * Resolve edit blocks against the active document and build an EditProposal.
 * Returns null when nothing resolves (no hunks).
 */
async function buildEditProposal(
  app: App,
  plugin: WritingAssistantChat,
  filePath: string,
  blocks: EditBlock[],
  prose: string,
): Promise<EditProposal | null> {
  // Resolve structural edit blocks (replace_section, insert_at_position,
  // update_frontmatter) that need MetadataCache or document content.
  let resolved = blocks;
  if (blocks.some((b) => b.toolName)) {
    resolved = await resolveStructuralEditBlocks(blocks, { app, filePath });
  }

  const file = app.vault.getFileByPath(filePath);
  if (!file) return null;
  const documentText = await app.vault.read(file);

  const resolvedEdits = resolveEdits(resolved, documentText, {
    contextLines: plugin.settings.diffContextLines,
    minConfidence: plugin.settings.diffMinMatchConfidence,
  });
  const hunks = buildHunks(resolvedEdits);
  if (hunks.length === 0) return null;

  return {
    id: generateId(),
    targetFilePath: filePath,
    documentSnapshot: documentText,
    snapshotTimestamp: Date.now(),
    hunks,
    prose,
  };
}

interface ExtendedMetadataCache extends MetadataCache {
  getBacklinksForFile(file: TFile): { data: Record<string, unknown[]> };
}

/** Number of notes that link to a file — the `linkImpact` shown for move ops (§6). */
function backlinkCount(app: App, path: string): number {
  const file = app.vault.getFileByPath(normalizePath(path));
  if (!file) return 0;
  const backlinks = (app.metadataCache as ExtendedMetadataCache).getBacklinksForFile(file);
  return Object.keys(backlinks?.data ?? {}).length;
}

/**
 * Convert vault-op tool calls into a reviewable proposal (spec §6 steps 1–4):
 * convert → capture fingerprints/snapshots → resolveGate (threading the per-turn
 * auto count) → summarize. Returns null when nothing converts.
 */
async function buildVaultOpProposal(
  app: App,
  vaultOpCalls: ToolCall[],
  prose: string | undefined,
  stoppedForMaxTokens: boolean,
  policy: VaultOpPolicy,
): Promise<VaultOperationProposal | null> {
  // Pre-read trash snapshots (async) so the pure conversion can stay synchronous;
  // a trashed file's snapshot is what its inverse re-creates on undo (§7.4).
  const snapshots = new Map<string, string>();
  for (const tc of vaultOpCalls) {
    if (tc.name === "trash_file" && typeof tc.arguments.path === "string") {
      const content = await readContentOrNull(app, tc.arguments.path);
      if (content !== null) snapshots.set(normalizePath(tc.arguments.path), content);
    }
  }

  const probes: ConversionProbes = {
    resolve: (p) => diskState(app, p),
    fingerprint: (p) => diskFingerprint(app, p),
    readContent: (p) => snapshots.get(normalizePath(p)) ?? null,
  };

  const { ops, errors } = toVaultOperations(vaultOpCalls, probes, { stoppedForMaxTokens });
  for (const e of errors) {
    console.error(`[vault-op] Skipping ${e.toolName} (${e.toolCallId}): ${e.error}`);
  }
  if (ops.length === 0) return null;

  let autoSoFar = 0;
  const reviewable: ReviewableVaultOp[] = [];
  for (const op of ops) {
    const gate = resolveGate(op, policy, autoSoFar);
    if (gate === "deny") continue; // denied tools are filtered upstream (Phase 4); guard anyway.
    if (gate === "auto") autoSoFar++;
    const reviewableOp: ReviewableVaultOp = {
      id: generateId(),
      op,
      gate,
      status: "pending",
      summary: summarizeOp(op),
    };
    if (op.kind === "move") reviewableOp.linkImpact = backlinkCount(app, op.from);
    reviewable.push(reviewableOp);
  }
  if (reviewable.length === 0) return null;

  return {
    id: generateId(),
    ops: reviewable,
    createdAt: Date.now(),
    ...(prose ? { prose } : {}),
  };
}

/**
 * Render the edit and/or vault-op review panels for a message into its bubble.
 * Used both at finalization and when re-rendering historical messages — each
 * channel gets its own container so they coexist (spec §6, "up to two panels").
 */
export function renderProposalPanels(
  app: App,
  owner: Component,
  store: ChatSessionStore,
  bubble: BubbleRefs,
  message: ConversationMessage,
  opts?: { autoApplyVaultOps?: boolean },
): void {
  bubble.contentEl.empty();
  bubble.contentEl.removeClass("lmsa-message-content--plain", "lmsa-message-content--markdown");

  if (message.editProposal) {
    const editContainer = bubble.contentEl.createDiv();
    new DiffReviewPanel(
      editContainer,
      app,
      owner,
      message.editProposal,
      makeEditCallbacks(store, message.editProposal),
      message.appliedEdit,
    );
  }

  if (message.vaultOpProposal) {
    const opsContainer = bubble.contentEl.createDiv();
    new VaultOperationReviewPanel(
      opsContainer,
      app,
      owner,
      message.vaultOpProposal,
      makeVaultOpCallbacks(store, message.vaultOpProposal),
      message.appliedVaultOps,
      opts?.autoApplyVaultOps ?? false,
    );
  }
}

function makeEditCallbacks(store: ChatSessionStore, proposal: EditProposal): DiffPanelCallbacks {
  const find = (id: string) =>
    store.getSnapshot().messageHistory.find((m) => m.editProposal?.id === id);
  return {
    onHunksChanged: (updated) => {
      const msg = find(updated.id);
      if (msg) {
        msg.editProposal = updated;
        void store.persistActiveConversation();
      }
    },
    onApplied: (record) => {
      const msg = find(proposal.id);
      if (msg) {
        msg.appliedEdit = record;
        void store.persistActiveConversation();
      }
    },
    onUndone: () => {
      const msg = find(proposal.id);
      if (msg) {
        msg.appliedEdit = undefined;
        void store.persistActiveConversation();
      }
    },
  };
}

function makeVaultOpCallbacks(
  store: ChatSessionStore,
  proposal: VaultOperationProposal,
): VaultOpPanelCallbacks {
  const find = (id: string) =>
    store.getSnapshot().messageHistory.find((m) => m.vaultOpProposal?.id === id);
  return {
    onOpsChanged: (updated) => {
      const msg = find(updated.id);
      if (msg) {
        msg.vaultOpProposal = updated;
        void store.persistActiveConversation();
      }
    },
    onApplied: (record) => {
      const msg = find(proposal.id);
      if (msg) {
        msg.appliedVaultOps = record;
        void store.persistActiveConversation();
      }
    },
    onUndone: () => {
      const msg = find(proposal.id);
      if (msg) {
        msg.appliedVaultOps = undefined;
        void store.persistActiveConversation();
      }
    },
  };
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

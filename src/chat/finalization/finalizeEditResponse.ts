import {
  type App,
  type MetadataCache,
  type TFile,
  Component,
  MarkdownRenderer,
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
  AppliedVaultOpRecord,
  ReviewableVaultOp,
  VaultOperationProposal,
} from "../../vault-ops/types";
import { generateId } from "../../utils";
import { makeMessage } from "../conversation/conversationUtils";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";
import type { ChatTranscript } from "../messages/ChatTranscript";
import { DiffReviewPanel, type DiffPanelCallbacks } from "../messages/DiffReviewPanel";
import {
  VaultReviewTimelineView,
  type VaultReviewCallbacks,
} from "../messages/vaultReviewTimeline";
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
  /** True when generation stopped for max_tokens — arms the write_file truncation guard. */
  stoppedForMaxTokens?: boolean;
  /**
   * A vault-op proposal already built and (partly) resolved in-loop by
   * {@link LiveVaultReview} (in-loop-tool-approval-blocking-flow). When present,
   * finalization persists it as-is instead of re-deriving one — the gate is
   * already resolved and ops are already applied/declined, so no re-apply happens.
   */
  prebuiltVaultOpProposal?: VaultOperationProposal;
  /** The applied record (auto + approved ops) for {@link prebuiltVaultOpProposal}. */
  prebuiltVaultOpRecord?: AppliedVaultOpRecord;
}

/**
 * Post-generation handler for edit mode.
 *
 * Partitions the model's write tool calls into two channels and renders their
 * reviews in the bubble:
 *   - the **edit channel** (active-document-bound) → an {@link EditProposal} / DiffReviewPanel;
 *   - the **vault-op channel** (whole-vault) → a {@link VaultOperationProposal}, folded onto
 *     the timeline tool-call steps by {@link VaultReviewTimelineView} — needs no active file.
 *
 * Falls back to a plain message ONLY when both channels are empty — so a pure
 * file-ops turn (e.g. "create a new note" with no document open) is no longer
 * silently dropped, the bug the old no-active-file bail caused.
 */
export async function finalizeEditResponse(options: FinalizeEditOptions): Promise<void> {
  const {
    app, owner, store, transcript, bubble, renderer, plugin, modelId, provider, usage,
    toolCalls, agenticSteps, stoppedForMaxTokens,
    prebuiltVaultOpProposal, prebuiltVaultOpRecord,
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
  //
  // A prebuilt proposal from the in-loop review (LiveVaultReview) is persisted
  // as-is: its gate is already resolved and its ops already applied/declined, so we
  // must NOT re-derive or re-apply. We only graft the turn's prose onto it.
  let vaultOpProposal: VaultOperationProposal | null = null;
  if (prebuiltVaultOpProposal) {
    vaultOpProposal = prebuiltVaultOpProposal;
    if (!editProposal && prose && !vaultOpProposal.prose) vaultOpProposal.prose = prose;
  } else if (vaultOpCalls.length > 0) {
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
  if (prebuiltVaultOpRecord) assistantMessage.appliedVaultOps = prebuiltVaultOpRecord;
  if (hasToolCalls) assistantMessage.toolCalls = toolCalls;
  if (agenticSteps?.length) assistantMessage.agenticSteps = agenticSteps;
  attachUsageToMessage(assistantMessage, modelId, provider, usage);
  store.appendMessage(assistantMessage);
  store.setLastAssistantResponse(fullResponse);
  transcript.registerBubble(assistantMessage.id, bubble);

  // Render the review panel(s). A prebuilt (in-loop) proposal is already resolved
  // and applied, so don't auto-apply again; a freshly-derived proposal auto-applies
  // its auto-gated ops on mount.
  renderProposalPanels(app, owner, store, bubble, assistantMessage, {
    autoApplyVaultOps: !prebuiltVaultOpProposal,
  });
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

/** Number of notes that link to a file — the `linkImpact` shown for move ops. */
function backlinkCount(app: App, path: string): number {
  const file = app.vault.getFileByPath(normalizePath(path));
  if (!file) return 0;
  const backlinks = (app.metadataCache as ExtendedMetadataCache).getBacklinksForFile(file);
  return Object.keys(backlinks?.data ?? {}).length;
}

/**
 * Convert vault-op tool calls into a reviewable proposal:
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
  // a trashed file's snapshot is what its inverse re-creates on undo.
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

  const { ops, sources, satisfied, errors } = toVaultOperations(vaultOpCalls, probes, {
    stoppedForMaxTokens,
  });
  for (const e of errors) {
    console.error(`[vault-op] Skipping ${e.toolName} (${e.toolCallId}): ${e.error}`);
  }
  if (ops.length === 0) return null;

  let autoSoFar = 0;
  const reviewable: ReviewableVaultOp[] = [];
  ops.forEach((op, i) => {
    // Already-satisfied no-ops (e.g. create_directory on an existing folder) are
    // informational only: never gated, never applied — shown on their step as a
    // muted "already exists" note.
    const isSatisfied = satisfied[i];
    const gate = isSatisfied ? "auto" : resolveGate(op, policy, autoSoFar);
    if (gate === "deny") return; // denied tools are filtered upstream (Phase 4); guard anyway.
    if (gate === "auto" && !isSatisfied) autoSoFar++;
    const reviewableOp: ReviewableVaultOp = {
      id: generateId(),
      op,
      gate,
      status: isSatisfied ? "satisfied" : "pending",
      summary: summarizeOp(op),
      sourceToolCallId: sources[i],
    };
    if (op.kind === "move") reviewableOp.linkImpact = backlinkCount(app, op.from);
    reviewable.push(reviewableOp);
  });
  if (reviewable.length === 0) return null;

  return {
    id: generateId(),
    ops: reviewable,
    createdAt: Date.now(),
    ...(prose ? { prose } : {}),
  };
}

/**
 * Render the edit and/or vault-op review for a message into its bubble.
 *
 * The two channels live in different regions of the bubble (Finding C re-open):
 *   - the **edit channel** stays in the body card (`contentEl`) as a DiffReviewPanel,
 *     which is a genuine inline diff and carries its own prose;
 *   - the **vault-op channel** is folded into the agentic timeline: the vault ops
 *     *are* tool calls, already shown as timeline steps, so {@link VaultReviewTimelineView}
 *     decorates those steps with inline approve/decline rather than rendering a separate
 *     panel. Its prose renders into the body card, so the card holds prose and the rail
 *     holds the (now interactive) tool-call steps.
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

  // --- Body card: the edit panel (with its own prose), or — for a vault-only
  // turn — the vault proposal's prose, since its review lives in the timeline. ---
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
  } else if (message.vaultOpProposal?.prose) {
    renderProseInto(app, owner, bubble.contentEl, message.vaultOpProposal.prose);
  }

  // --- Timeline: fold the vault review onto the tool-call steps in place. ---
  if (message.vaultOpProposal) {
    new VaultReviewTimelineView({
      timelineEl: bubble.timelineEl,
      app,
      proposal: message.vaultOpProposal,
      callbacks: makeVaultOpCallbacks(store, message.vaultOpProposal),
      existingRecord: message.appliedVaultOps,
      autoApply: opts?.autoApplyVaultOps ?? false,
    });
  }
}

/** Render assistant prose as markdown, with a child component for cleanup. */
function renderProseInto(app: App, owner: Component, el: HTMLElement, prose: string): void {
  const proseEl = el.createDiv({ cls: "lmsa-chat-window-message-content--markdown" });
  const renderChild = new Component();
  owner.addChild(renderChild);
  const sourcePath = app.workspace.getActiveFile()?.path ?? "";
  void MarkdownRenderer.render(app, prose, proseEl, sourcePath, renderChild).catch(() => {
    proseEl.setText(prose);
  });
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
): VaultReviewCallbacks {
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

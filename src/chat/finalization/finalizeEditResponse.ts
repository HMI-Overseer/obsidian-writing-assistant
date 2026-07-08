import { type App, type Component, Notice, normalizePath } from "obsidian";
import { parseEditBlocks } from "../../editing/parseEditBlocks";
import { toolCallsToEditBlocks } from "../../tools/editing/conversion";
import { resolveStructuralEditBlocks } from "../../tools/editing/handlers";
import { resolveEdits, buildHunks } from "../../editing/diffEngine";
import type { AppliedEditRecord, EditBlock, EditProposal } from "../../editing/editTypes";
import { EDIT_TOOL_NAMES } from "../../tools/editing/definition";
import { VAULT_OPS_TOOL_NAMES } from "../../tools/vault-ops/definition";
import { toVaultOperations, type ConversionProbes } from "../../tools/vault-ops/conversion";
import { diskState, diskFingerprint } from "../../vault-ops/apply";
import type { VaultOpPolicy } from "../../vault-ops/gateway";
import {
  preReadTrashSnapshots,
  preScanReplacements,
  gateConvertedOp,
  buildReviewableOp,
} from "../../vault-ops/proposalSupport";
import type {
  AppliedVaultOpRecord,
  ReviewableVaultOp,
  VaultOperationProposal,
} from "../../vault-ops/types";
import { generateId } from "../../utils";
import { appliedEditsOf, editProposalsOf, makeMessage } from "../conversation/conversationUtils";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";
import type { ChatTranscript } from "../messages/ChatTranscript";
import { EditReviewTimelineView } from "../messages/editReviewTimeline";
import { MarkdownItBubbleRenderer } from "../rendering/MarkdownItBubbleRenderer";
import {
  EditReviewController,
  type EditReviewCallbacks,
} from "../../editing/EditReviewController";
import type { InlineDiffManager } from "../../editing/inlineDiff/InlineDiffManager";
import {
  VaultReviewTimelineView,
  type VaultReviewCallbacks,
} from "../messages/vaultReviewTimeline";
import type { BubbleRefs } from "../types";
import type { EditStreamingRenderer } from "../streaming/EditStreamingRenderer";
import type WritingAssistantChat from "../../main";
import type { AgenticStep, ApprovalPosture, ConversationMessage, ProviderOption } from "../../shared/types";
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
  /** True when generation stopped for max_tokens, arms the write_file truncation guard. */
  stoppedForMaxTokens?: boolean;
  /** Session approval posture; `auto` overrules the per-class policy to auto-apply (section 6.3). */
  posture?: ApprovalPosture;
  /**
   * A vault-op proposal already built and (partly) resolved in-loop by
   * {@link LiveVaultReview} (in-loop-tool-approval-blocking-flow). When present,
   * finalization persists it as-is instead of re-deriving one, the gate is
   * already resolved and ops are already applied/declined, so no re-apply happens.
   */
  prebuiltVaultOpProposal?: VaultOperationProposal;
  /** The applied record (auto + approved ops) for {@link prebuiltVaultOpProposal}. */
  prebuiltVaultOpRecord?: AppliedVaultOpRecord;
  /**
   * Edit proposals already built and (partly) resolved in-loop by {@link LiveVaultReview}
   * (propose-edit-in-loop-blocking-review), one per edited file (ADR-0010). When present,
   * finalization persists them as-is instead of re-resolving the edit blocks, the hunks
   * already carry their accepted/rejected status and applied content.
   */
  prebuiltEditProposals?: EditProposal[];
  /** The applied edit records (auto + accepted hunks), one per edited file. */
  prebuiltEditRecords?: AppliedEditRecord[];
  /** Flip the session to auto-apply; powers the review's "Accept all this session" action. */
  onEnterAutoApply?: () => void;
}

/**
 * Post-generation handler for edit mode.
 *
 * Partitions the model's write tool calls into two channels, both folded onto their
 * timeline tool-call steps:
 *   - the **edit channel** (active-document-bound) → an {@link EditProposal}, reviewed by
 *     {@link EditReviewTimelineView};
 *   - the **vault-op channel** (whole-vault) → a {@link VaultOperationProposal}, reviewed by
 *     {@link VaultReviewTimelineView}, needs no active file.
 *
 * Falls back to a plain message ONLY when both channels are empty, so a pure
 * file-ops turn (e.g. "create a new note" with no document open) is no longer
 * silently dropped, the bug the old no-active-file bail caused.
 */
export async function finalizeEditResponse(options: FinalizeEditOptions): Promise<void> {
  const {
    app, owner, store, transcript, bubble, renderer, plugin, modelId, provider, usage,
    toolCalls, agenticSteps, stoppedForMaxTokens,
    prebuiltVaultOpProposal, prebuiltVaultOpRecord,
    prebuiltEditProposals, prebuiltEditRecords, onEnterAutoApply,
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

  // Prebuilt proposals from the in-loop review are persisted as-is (one per edited
  // file): their hunks are already resolved against each document and carry their
  // accept/reject status, so we must NOT re-resolve. We only graft the turn's prose
  // onto one of them (the first that lacks it) so it renders once.
  let editProposals: EditProposal[] = [];
  if (prebuiltEditProposals && prebuiltEditProposals.length > 0) {
    editProposals = prebuiltEditProposals;
    if (prose) {
      const target = editProposals.find((p) => !p.prose);
      if (target) target.prose = prose;
    }
  } else if (blocks.length > 0) {
    // Group edit blocks by their target file (tool-call edits carry an explicit `path`;
    // regex-parsed blocks fall back to the active file), one single-file proposal per
    // file (ADR-0010). The prose rides on the first successfully-built proposal only.
    const groups = groupBlocksByTarget(blocks, app.workspace.getActiveFile()?.path);
    for (const [path, groupBlocks] of groups) {
      const proseForGroup = editProposals.length === 0 ? prose : "";
      const built = await buildEditProposal(app, plugin, path, groupBlocks, proseForGroup);
      if (built) editProposals.push(built);
    }
  }

  // --- Vault-op channel: builds a proposal with no active file required. ---
  // The prose belongs to the edit panel when both channels fire (so it never shows
  // twice); otherwise the vault-op panel renders it.
  //
  // A prebuilt proposal from the in-loop review (LiveVaultReview) is persisted
  // as-is: its gate is already resolved and its ops already applied/declined, so we
  // must NOT re-derive or re-apply. We only graft the turn's prose onto it.
  const hasEdits = editProposals.length > 0;
  let vaultOpProposal: VaultOperationProposal | null = null;
  if (prebuiltVaultOpProposal) {
    vaultOpProposal = prebuiltVaultOpProposal;
    if (!hasEdits && prose && !vaultOpProposal.prose) vaultOpProposal.prose = prose;
  } else if (vaultOpCalls.length > 0) {
    vaultOpProposal = await buildVaultOpProposal(
      app,
      vaultOpCalls,
      hasEdits ? undefined : prose,
      stoppedForMaxTokens ?? false,
      plugin.settings.vaultOpPolicy,
      options.posture ?? "ask",
    );
  }

  // Bail to a plain message ONLY when BOTH channels are empty.
  if (!hasEdits && !vaultOpProposal) {
    if (!hasToolCalls && fullResponse.includes("<<<SEARCH")) {
      new Notice("Edit blocks were detected but couldn't be parsed.");
    }
    await renderAsNormalMessage(store, transcript, bubble, fullResponse, modelId, provider, usage, agenticSteps);
    return;
  }

  // Save the message with whichever proposals are present.
  const assistantMessage = makeMessage("assistant", fullResponse);
  if (hasEdits) assistantMessage.editProposals = editProposals;
  if (prebuiltEditRecords?.length) assistantMessage.appliedEdits = prebuiltEditRecords;
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
  renderProposalPanels(app, owner, store, bubble, assistantMessage, plugin.inlineDiff, {
    autoApplyVaultOps: !prebuiltVaultOpProposal,
    ...(onEnterAutoApply && { onEnterAutoApply }),
  });
}

/**
 * Group edit blocks by the file they target, preserving first-seen order (ADR-0010:
 * a turn may edit N files). Tool-call edits carry an explicit `targetPath`; regex-parsed
 * blocks have none and fall back to `activeFilePath` (the open note). A block with no
 * target and no active file is dropped, it has nowhere to land.
 */
function groupBlocksByTarget(
  blocks: EditBlock[],
  activeFilePath: string | undefined,
): Map<string, EditBlock[]> {
  const groups = new Map<string, EditBlock[]>();
  for (const block of blocks) {
    const path = block.targetPath ?? activeFilePath;
    if (!path) continue;
    const existing = groups.get(path);
    if (existing) existing.push(block);
    else groups.set(path, [block]);
  }
  return groups;
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
  // Resolve structural edit blocks (insert_into_note, update_frontmatter) that
  // need document content or MetadataCache to populate searchText/replaceText.
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
  posture: ApprovalPosture,
): Promise<VaultOperationProposal | null> {
  // A trashed file's snapshot is what its inverse re-creates on undo; pre-read so
  // the pure conversion below can stay synchronous. A replace's per-file targets are
  // scanned the same way (async reads → synchronous conversion).
  const snapshots = await preReadTrashSnapshots(app, vaultOpCalls);
  const replaceScans = await preScanReplacements(app, vaultOpCalls);

  const probes: ConversionProbes = {
    resolve: (p) => diskState(app, p),
    fingerprint: (p) => diskFingerprint(app, p),
    readContent: (p) => snapshots.get(normalizePath(p)) ?? null,
    configDir: app.vault.configDir,
    replaceTargets: (callId) => replaceScans.get(callId) ?? null,
  };

  const { ops, sources, satisfied } = toVaultOperations(vaultOpCalls, probes, {
    stoppedForMaxTokens,
  });
  // Conversion errors are not logged here: the in-loop resolveRound already
  // surfaced each as a self-correcting tool result on its timeline step.
  if (ops.length === 0) return null;

  let autoSoFar = 0;
  const reviewable: ReviewableVaultOp[] = [];
  ops.forEach((op, i) => {
    // Already-satisfied no-ops (e.g. create_directory on an existing folder) are
    // informational only: never gated, never applied, shown on their step as a
    // muted "already exists" note.
    const isSatisfied = satisfied[i];
    const { gate, autoConsumed } = gateConvertedOp(op, isSatisfied, policy, autoSoFar, posture);
    if (gate === "deny") return; // denied tools are filtered upstream (Phase 4); guard anyway.
    if (autoConsumed) autoSoFar++;
    reviewable.push(buildReviewableOp(app, op, gate, isSatisfied, sources[i]));
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
 * Both review channels are folded into the agentic timeline, the write calls *are*
 * tool-call steps, so each review lives *on its step* rather than in a separate panel:
 *   - the **edit channel** via {@link EditReviewTimelineView}, each hunk decorates its
 *     `propose_edit` step with an inline status and an expandable diff (accept/reject/undo);
 *   - the **vault-op channel** via {@link VaultReviewTimelineView}, inline approve/decline.
 * The body card holds only the turn's prose, so the card reads as text and the rail holds
 * the interactive steps. The in-note overlay ({@link InlineDiffManager}) is a second view
 * over the same edit controller.
 */
export function renderProposalPanels(
  app: App,
  owner: Component,
  store: ChatSessionStore,
  bubble: BubbleRefs,
  message: ConversationMessage,
  inlineDiff: InlineDiffManager,
  opts?: { autoApplyVaultOps?: boolean; onEnterAutoApply?: () => void },
): void {
  bubble.contentEl.empty();
  bubble.contentEl.removeClass("lmsa-message-content--plain", "lmsa-message-content--markdown");

  // --- Body card: the turn's prose only. Both review channels now live on the
  // timeline (edits via EditReviewTimelineView, vault ops via VaultReviewTimelineView),
  // so the body holds the explanatory text and the rails hold the interactive steps.
  // Prose belongs to whichever channel carries it; when both fire only the edit
  // channel does (finalize assigns prose to the edit proposal first). ---
  const editProposals = editProposalsOf(message);
  if (editProposals.length > 0) {
    // Prose belongs to one card so it shows once (finalize assigns it to the first
    // proposal that carries it).
    const proseProposal = editProposals.find((p) => p.prose);
    if (proseProposal?.prose) {
      renderProseInto(app, bubble.contentEl, proseProposal.prose);
    }
    // One controller per edited file owns that file's review; a single composite
    // timeline view spans them (one card per file, ADR-0010), and the in-note overlay
    // attaches each so whichever file is open shows its diff.
    const appliedEdits = appliedEditsOf(message);
    const controllers = editProposals.map(
      (proposal) =>
        new EditReviewController(
          app,
          proposal,
          makeEditCallbacks(store, proposal),
          appliedEdits.find((r) => r.proposalId === proposal.id),
        ),
    );
    new EditReviewTimelineView({
      timelineEl: bubble.timelineEl,
      app,
      controllers,
      ...(opts?.onEnterAutoApply && { onEnterAutoApply: opts.onEnterAutoApply }),
    });
    for (const controller of controllers) inlineDiff.attach(controller);
  } else if (message.vaultOpProposal?.prose) {
    renderProseInto(app, bubble.contentEl, message.vaultOpProposal.prose);
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

/**
 * Render assistant prose through the same markdown-it pipeline as chat bubbles, so
 * code blocks, links, and copy buttons render identically here, rather than via
 * Obsidian's MarkdownRenderer, which produced inconsistent fenced-code output.
 */
function renderProseInto(app: App, el: HTMLElement, prose: string): void {
  const proseEl = el.createDiv({ cls: "lmsa-chat-window-message-content--markdown" });
  void new MarkdownItBubbleRenderer(app).render(proseEl, prose);
}

function makeEditCallbacks(store: ChatSessionStore, proposal: EditProposal): EditReviewCallbacks {
  // The message holding this proposal, located by proposal id within its array (a turn
  // may hold N proposals, one per file; ADR-0010).
  const find = (id: string) =>
    store.getSnapshot().messageHistory.find((m) => editProposalsOf(m).some((p) => p.id === id));
  return {
    onHunksChanged: (updated) => {
      const msg = find(updated.id);
      if (!msg) return;
      msg.editProposals = editProposalsOf(msg).map((p) => (p.id === updated.id ? updated : p));
      msg.editProposal = undefined; // migrate off the legacy singular once we rewrite.
      void store.persistActiveConversation();
    },
    onApplied: (record) => {
      const msg = find(proposal.id);
      if (!msg) return;
      msg.appliedEdits = upsertAppliedEdit(appliedEditsOf(msg), record);
      msg.appliedEdit = undefined;
      void store.persistActiveConversation();
    },
    onUndone: () => {
      const msg = find(proposal.id);
      if (!msg) return;
      msg.appliedEdits = appliedEditsOf(msg).filter((r) => r.proposalId !== proposal.id);
      msg.appliedEdit = undefined;
      void store.persistActiveConversation();
    },
  };
}

/** Replace the applied-edit record for a proposal, or append it if new (per-file, ADR-0010). */
function upsertAppliedEdit(
  records: AppliedEditRecord[],
  record: AppliedEditRecord,
): AppliedEditRecord[] {
  const rest = records.filter((r) => r.proposalId !== record.proposalId);
  return [...rest, record];
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

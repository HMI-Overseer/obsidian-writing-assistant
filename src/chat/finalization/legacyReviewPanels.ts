import type { App } from "obsidian";
import {
  EditReviewController,
  type EditReviewCallbacks,
} from "../../editing/EditReviewController";
import type {
  EditProposal,
} from "../../editing/editTypes";
import type { VaultOperationProposal } from "../../vault-ops/types";
import type { ConversationMessage } from "../../shared/types";
import {
  appliedEditsOf,
  editProposalsOf,
} from "../conversation/conversationUtils";
import { EditReviewTimelineView } from "../messages/editReviewTimeline";
import {
  VaultReviewTimelineView,
  type VaultReviewCallbacks,
} from "../messages/vaultReviewTimeline";
import type { AssistantBubbleRefs } from "../types";

const READ_ONLY_EDIT_CALLBACKS: EditReviewCallbacks = {
  onHunksChanged: () => undefined,
  onApplied: () => undefined,
  onUndone: () => undefined,
};

const READ_ONLY_VAULT_CALLBACKS: VaultReviewCallbacks = {
  onOpsChanged: () => undefined,
  onApplied: () => undefined,
  onUndone: () => undefined,
};

/**
 * Render load-only legacy review evidence.
 *
 * Legacy proposals have no canonical action ledger. They remain visible for
 * historical audit, but Phase 8 never exposes controls or writes their fields.
 */
export function renderLegacyReviewPanels(
  app: App,
  bubble: AssistantBubbleRefs,
  message: ConversationMessage,
): void {
  if (message.actionLedger?.length) return;
  renderLegacyEditHistory(app, bubble, message);
  renderLegacyVaultHistory(app, bubble, message);
}

function renderLegacyEditHistory(
  app: App,
  bubble: AssistantBubbleRefs,
  message: ConversationMessage,
): void {
  const proposals = editProposalsOf(message);
  if (proposals.length === 0) return;
  const applied = appliedEditsOf(message);
  const controllers = proposals.map(
    (proposal) =>
      new EditReviewController(
        app,
        proposal,
        READ_ONLY_EDIT_CALLBACKS,
        applied.find((record) => record.proposalId === proposal.id),
      ),
  );
  new EditReviewTimelineView({
    timelineEl: bubble.turnView.rootEl,
    findActionHostByToolCallId: exactEditHostResolver(
      bubble,
      proposals,
    ),
    app,
    controllers,
    readOnly: true,
  });
}

function exactEditHostResolver(
  bubble: AssistantBubbleRefs,
  proposals: EditProposal[],
): ((toolCallId: string) => HTMLElement | null) | undefined {
  const exact = proposals.every((proposal) =>
    proposal.hunks.every(
      (hunk) =>
        bubble.turnView.getReviewHostForToolCallId(hunk.id) !== null,
    ),
  );
  return exact
    ? (toolCallId) =>
        bubble.turnView.getReviewHostForToolCallId(toolCallId)
    : undefined;
}

function renderLegacyVaultHistory(
  app: App,
  bubble: AssistantBubbleRefs,
  message: ConversationMessage,
): void {
  const proposal = message.vaultOpProposal;
  if (!proposal) return;
  new VaultReviewTimelineView({
    timelineEl: bubble.turnView.rootEl,
    findActionHostByToolCallId: exactVaultHostResolver(
      bubble,
      proposal,
    ),
    app,
    proposal: {
      ...structuredClone(proposal),
      historical: true,
    },
    callbacks: READ_ONLY_VAULT_CALLBACKS,
    existingRecord: message.appliedVaultOps,
    autoApply: false,
  });
}

function exactVaultHostResolver(
  bubble: AssistantBubbleRefs,
  proposal: VaultOperationProposal,
): ((toolCallId: string) => HTMLElement | null) | undefined {
  const exact = proposal.ops.every(
    (operation) =>
      operation.sourceToolCallId !== undefined &&
      bubble.turnView.getReviewHostForToolCallId(
        operation.sourceToolCallId,
      ) !== null,
  );
  return exact
    ? (toolCallId) =>
        bubble.turnView.getReviewHostForToolCallId(toolCallId)
    : undefined;
}

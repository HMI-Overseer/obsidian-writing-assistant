import type {
  AssistantTurnRevision,
  ConversationMessage,
  ToolActionLedgerEntry,
} from "../../shared/types";
import {
  createTurnRevision,
  syncAssistantCompatibilityProjection,
  type CreateTurnRevisionInput,
} from "../conversation/assistantRevisions";

export interface CreateAssistantTurnMessageInput {
  messageId: string;
  revision: AssistantTurnRevision;
  actionLedger: ToolActionLedgerEntry[];
}

/** Build the immutable generated-content revision before it reaches session state. */
export function createAssistantTurnRevision(
  input: CreateTurnRevisionInput,
): AssistantTurnRevision {
  return createTurnRevision(input);
}

/**
 * Build one chain-backed assistant message.
 *
 * The selected revision is canonical. Top-level prose and metadata are written only
 * by the compatibility projection, and mutable review state has one ledger owner.
 */
export function createAssistantTurnMessage(
  input: CreateAssistantTurnMessageInput,
): ConversationMessage {
  if (input.messageId.trim().length === 0) {
    throw new Error("messageId must be a non-empty string.");
  }
  if (input.revision.kind !== "turn") {
    throw new Error("A generated assistant message requires a turn revision.");
  }
  return syncAssistantCompatibilityProjection({
    id: input.messageId,
    role: "assistant",
    content: "",
    revisions: [structuredClone(input.revision)],
    activeRevisionId: input.revision.revisionId,
    actionLedger: structuredClone(input.actionLedger),
  });
}

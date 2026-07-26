import type {
  AssistantMessageRevision,
  AssistantReplayEvidence,
  AssistantTurnRecord,
  AssistantTurnRevision,
  ConversationMessage,
  MessageUsage,
  ProviderOption,
  RagSourceRef,
} from "../../shared/types";
import {
  allVisibleProse,
  rawConcatenatedProse,
} from "../turns/assistantTurnProjections";
import { validateAssistantTurn } from "../turns/assistantTurnValidation";

export interface CreateTurnRevisionInput {
  revisionId: string;
  origin: AssistantTurnRevision["origin"];
  parentRevisionId?: string;
  createdAt: number;
  provider: ProviderOption;
  modelId: string;
  turn: AssistantTurnRecord;
  replayEvidence?: AssistantReplayEvidence;
  usage?: MessageUsage;
  ragSources?: RagSourceRef[];
  rewrittenQuery?: string;
  isError?: boolean;
  interrupted?: boolean;
  errorMessage?: string;
}

export interface CopyTurnWithProvenanceOptions {
  turnId: string;
  itemId: (sourceItemId: string, index: number) => string;
}

export interface CreateEditedRevisionInput {
  sourceRevision: AssistantTurnRevision;
  revisionId: string;
  turnId: string;
  createdAt: number;
  targetProseItemId: string;
  text: string;
  itemId: (sourceItemId: string, index: number) => string;
}

export interface MeaningfulAssistantReplacementInput {
  provider: ProviderOption;
  turn: AssistantTurnRecord;
  replayEvidence?: AssistantReplayEvidence;
  usage?: MessageUsage;
}

/**
 * Decide whether an ephemeral generation draft contains history that must be
 * committed as a replacement revision.
 */
export function isMeaningfulAssistantReplacement(
  input: MeaningfulAssistantReplacementInput,
): boolean {
  if (input.turn.items.length > 0) return true;
  return (
    input.provider === "claudecode" &&
    input.replayEvidence?.capabilities.nativeResume === true &&
    input.usage?.resumeCursor !== undefined
  );
}

/** Return the selected revision only when the message's stable pointer resolves. */
export function getActiveAssistantRevision(
  message: ConversationMessage,
): AssistantMessageRevision | null {
  if (
    message.role !== "assistant" ||
    !message.revisions ||
    !message.activeRevisionId
  ) {
    return null;
  }
  return (
    message.revisions.find(
      (revision) => revision.revisionId === message.activeRevisionId,
    ) ?? null
  );
}

/** Construct one detached, validated immutable turn revision. */
export function createTurnRevision(
  input: CreateTurnRevisionInput,
): AssistantTurnRevision {
  requireNonEmptyId(input.revisionId, "revisionId");
  requireTimestamp(input.createdAt, "createdAt");
  requireNonEmptyId(input.provider, "provider");
  requireNonEmptyId(input.modelId, "modelId");
  if (input.parentRevisionId !== undefined) {
    requireNonEmptyId(input.parentRevisionId, "parentRevisionId");
  }
  const turn = cloneValidatedTurn(input.turn);
  return {
    revisionId: input.revisionId,
    kind: "turn",
    origin: input.origin,
    ...(input.parentRevisionId === undefined
      ? {}
      : { parentRevisionId: input.parentRevisionId }),
    createdAt: input.createdAt,
    provider: input.provider,
    modelId: input.modelId,
    turn,
    ...(input.replayEvidence === undefined
      ? {}
      : { replayEvidence: structuredClone(input.replayEvidence) }),
    ...(input.usage === undefined
      ? {}
      : { usage: structuredClone(input.usage) }),
    ...(input.ragSources === undefined
      ? {}
      : { ragSources: structuredClone(input.ragSources) }),
    ...(input.rewrittenQuery === undefined
      ? {}
      : { rewrittenQuery: input.rewrittenQuery }),
    ...(input.isError === undefined ? {} : { isError: input.isError }),
    ...(input.interrupted === undefined
      ? {}
      : { interrupted: input.interrupted }),
    ...(input.errorMessage === undefined
      ? {}
      : { errorMessage: input.errorMessage }),
  };
}

/**
 * Copy one frozen turn for an edited revision.
 *
 * Segment identity and provider call identity remain historical replay evidence.
 * Every domain item receives a new identity and points to its immediate source.
 */
export function copyTurnWithProvenance(
  turn: AssistantTurnRecord,
  options: CopyTurnWithProvenanceOptions,
): AssistantTurnRecord {
  requireNonEmptyId(options.turnId, "turnId");
  const copied: AssistantTurnRecord = {
    ...structuredClone(turn),
    id: options.turnId,
    items: turn.items.map((item, index) => ({
      ...structuredClone(item),
      id: options.itemId(item.id, index),
      sourceItemId: item.id,
    })),
  };
  return cloneValidatedTurn(copied);
}

/** Replace exactly one existing prose item and leave every other item unchanged. */
export function replaceProseItemText(
  turn: AssistantTurnRecord,
  proseItemId: string,
  text: string,
): AssistantTurnRecord {
  if (text.length === 0) {
    throw new Error("Edited prose item text must not be empty.");
  }
  let matches = 0;
  const items = turn.items.map((item) => {
    if (item.id !== proseItemId) return structuredClone(item);
    if (item.type !== "prose") {
      throw new Error(`Item "${proseItemId}" is not a prose item.`);
    }
    matches += 1;
    return { ...structuredClone(item), text };
  });
  if (matches !== 1) {
    throw new Error(
      `Expected exactly one prose item "${proseItemId}", found ${matches}.`,
    );
  }
  return cloneValidatedTurn({ ...structuredClone(turn), items });
}

/** Create one copy-on-write edited child revision. */
export function createEditedRevision(
  input: CreateEditedRevisionInput,
): AssistantTurnRevision {
  const copied = copyTurnWithProvenance(input.sourceRevision.turn, {
    turnId: input.turnId,
    itemId: input.itemId,
  });
  const copiedTarget = copied.items.filter(
    (item) => item.sourceItemId === input.targetProseItemId,
  );
  if (copiedTarget.length !== 1) {
    throw new Error(
      `Expected exactly one copied source item "${input.targetProseItemId}".`,
    );
  }
  const editedTurn = replaceProseItemText(
    copied,
    copiedTarget[0].id,
    input.text,
  );
  const source = input.sourceRevision;
  return createTurnRevision({
    revisionId: input.revisionId,
    origin: "edited",
    parentRevisionId: source.revisionId,
    createdAt: input.createdAt,
    provider: source.provider,
    modelId: source.modelId,
    turn: editedTurn,
    replayEvidence:
      source.provider === "claudecode" && source.replayEvidence
        ? {
            ...structuredClone(source.replayEvidence),
            tier: "textual",
            loweredReason: "history-edited",
          }
        : source.replayEvidence,
    usage:
      source.provider === "claudecode"
        ? invalidateEditedResumeUsage(source.usage)
        : source.usage,
    ragSources: source.ragSources,
    rewrittenQuery: source.rewrittenQuery,
    isError: source.isError,
    interrupted: source.interrupted,
    errorMessage: source.errorMessage,
  });
}

function invalidateEditedResumeUsage(
  usage: MessageUsage | undefined,
): MessageUsage | undefined {
  if (!usage) return undefined;
  const edited = structuredClone(usage);
  delete edited.resumeCursor;
  delete edited.sessionReused;
  delete edited.sessionResumed;
  return edited;
}

/** Append a detached revision, select it, and derive compatibility fields once. */
export function appendAssistantRevision(
  message: ConversationMessage,
  revision: AssistantMessageRevision,
): ConversationMessage {
  if (message.role !== "assistant") {
    throw new Error("Only assistant messages can own revisions.");
  }
  const revisions = message.revisions ?? [];
  if (
    revisions.some(
      (existing) => existing.revisionId === revision.revisionId,
    )
  ) {
    throw new Error(`Duplicate revision ID "${revision.revisionId}".`);
  }
  return syncAssistantCompatibilityProjection({
    ...message,
    revisions: [
      ...structuredClone(revisions),
      structuredClone(revision),
    ],
    activeRevisionId: revision.revisionId,
  });
}

/** Select one existing revision without appending any action-ledger event. */
export function selectAssistantRevision(
  message: ConversationMessage,
  revisionId: string,
): ConversationMessage | null {
  if (
    message.role !== "assistant" ||
    !message.revisions?.some(
      (revision) => revision.revisionId === revisionId,
    )
  ) {
    return null;
  }
  return syncAssistantCompatibilityProjection({
    ...message,
    activeRevisionId: revisionId,
  });
}

/** All readable prose from the selected revision. */
export function assistantDisplayText(message: ConversationMessage): string {
  const revision = getActiveAssistantRevision(message);
  if (!revision) return message.content;
  return revision.kind === "turn"
    ? allVisibleProse(revision.turn)
    : revision.content;
}

/** Exact selected-revision prose bytes for raw textual replay. */
export function assistantRawReplayText(
  message: ConversationMessage,
): string {
  const revision = getActiveAssistantRevision(message);
  if (!revision) return message.content;
  return revision.kind === "turn"
    ? rawConcatenatedProse(revision.turn)
    : revision.content;
}

/** Error text belonging to the selected revision, without rewriting provider prose. */
export function assistantRevisionErrorMessage(
  message: ConversationMessage,
): string | null {
  return getActiveAssistantRevision(message)?.errorMessage ?? null;
}

/**
 * The only writer for top-level assistant compatibility fields.
 *
 * The returned message is detached at the top level. Revisions remain the source
 * of truth and are never mutated by synchronization.
 */
export function syncAssistantCompatibilityProjection(
  message: ConversationMessage,
): ConversationMessage {
  if (message.role !== "assistant") return message;
  const revision = getActiveAssistantRevision(message);
  if (!revision) return { ...message };

  const projected = { ...message };
  delete projected.usage;
  delete projected.ragSources;
  delete projected.rewrittenQuery;
  delete projected.provider;
  delete projected.modelId;
  delete projected.isError;
  delete projected.interrupted;

  projected.content =
    revision.kind === "turn"
      ? allVisibleProse(revision.turn)
      : revision.content;
  if (revision.usage !== undefined) {
    projected.usage = structuredClone(revision.usage);
  }
  if (revision.ragSources !== undefined) {
    projected.ragSources = structuredClone(revision.ragSources);
  }
  if (revision.rewrittenQuery !== undefined) {
    projected.rewrittenQuery = revision.rewrittenQuery;
  }
  if (revision.provider !== undefined) projected.provider = revision.provider;
  if (revision.modelId !== undefined) projected.modelId = revision.modelId;
  if (revision.isError !== undefined) projected.isError = revision.isError;
  if (revision.interrupted !== undefined) {
    projected.interrupted = revision.interrupted;
  }
  return projected;
}

function cloneValidatedTurn(turn: AssistantTurnRecord): AssistantTurnRecord {
  const clone = structuredClone(turn);
  const result = validateAssistantTurn(clone);
  if (!result.ok) {
    throw new Error(
      `Invalid assistant turn at ${result.reason.path}: ${result.reason.code}.`,
    );
  }
  return result.value;
}

function requireNonEmptyId(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
}

function requireTimestamp(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer.`);
  }
}

import type {
  AgenticStep,
  AssistantMessageRevision,
  AssistantReplayEvidence,
  AssistantTurnItem,
  AssistantTurnRecord,
  AssistantTurnRevision,
  CompletedAskGuidanceRecord,
  EditActionPayload,
  Memory,
  MemoryActionPayload,
  MessageUsage,
  ProviderOption,
  RagSourceRef,
  ToolActionCorrelationEvidence,
  ToolActionEffectRecord,
  ToolActionEvent,
  ToolActionLedgerEntry,
  ToolActionPlacement,
  ToolActionUndoRecord,
  VaultOpActionPayload,
} from "../../shared/types";
import type { ResolvedEdit } from "../../editing/editTypes";
import type { VaultOperation } from "../../vault-ops/types";
import { appendActionEvent } from "./actionLedger";
import { validateAssistantTurn } from "../turns/assistantTurnValidation";
import { lowerEvidenceFromCapture } from "../../shared/captureEvidence";

export const ASSISTANT_MESSAGE_MAX_REVISIONS = 128;
export const ASSISTANT_MESSAGE_MAX_LEDGER_ENTRIES = 1_024;
export const ASSISTANT_ACTION_MAX_TARGETS = 1_024;
export const ASSISTANT_ACTION_MAX_EVENTS = 4_096;
export const ASSISTANT_ACTION_MAX_TEXT_CHARS = 8_000;
export const ASSISTANT_ACTION_MAX_SNAPSHOT_CHARS = 1_000_000;

const MAX_ID_CHARS = 512;
const MAX_PATH_CHARS = 4_096;
const MAX_CONTENT_CHARS = 1_000_000;
const MAX_OPTIONS = 64;
const MAX_JSON_DEPTH = 32;
const PROVIDERS: readonly ProviderOption[] = [
  "lmstudio",
  "openai",
  "anthropic",
  "claudecode",
];

export type AssistantMessageInvalidReasonCode =
  | "state_invalid"
  | "field_unexpected"
  | "revisions_invalid"
  | "revisions_too_many"
  | "revision_invalid"
  | "revision_id_invalid"
  | "revision_id_duplicate"
  | "revision_kind_invalid"
  | "revision_attribution_invalid"
  | "revision_parent_invalid"
  | "revision_metadata_invalid"
  | "turn_invalid"
  | "legacy_content_invalid"
  | "legacy_steps_invalid"
  | "active_revision_invalid"
  | "ledger_invalid"
  | "ledger_too_many"
  | "action_ref_invalid"
  | "action_ref_duplicate"
  | "action_revision_invalid"
  | "family_invalid"
  | "placement_invalid"
  | "correlation_invalid"
  | "payload_invalid"
  | "targets_too_many"
  | "target_id_duplicate"
  | "events_invalid"
  | "events_too_many"
  | "event_invalid"
  | "event_id_duplicate"
  | "event_sequence_invalid"
  | "placed_item_invalid"
  | "action_reference_invalid"
  | "source_item_invalid"
  | "item_id_duplicate";

export interface AssistantMessageInvalidReason {
  code: AssistantMessageInvalidReasonCode;
  path: string;
  detail?: string;
}

export interface ValidatedAssistantMessageState {
  revisions: AssistantMessageRevision[];
  activeRevisionId: string;
  actionLedger: ToolActionLedgerEntry[];
}

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: AssistantMessageInvalidReason };

export type AssistantMessageValidationResult =
  ValidationResult<ValidatedAssistantMessageState>;

interface RevisionIndex {
  revisionsById: Map<string, AssistantMessageRevision>;
  revisionOrder: Map<string, number>;
  itemsById: Map<
    string,
    {
      revision: AssistantTurnRevision;
      item: AssistantTurnItem;
      revisionIndex: number;
    }
  >;
}

/** Strictly validate one complete assistant revision and action-ledger chain. */
export function validateAssistantMessageState(
  value: unknown,
): AssistantMessageValidationResult {
  if (!isRecord(value)) return invalid("state_invalid", "$");
  const unexpected = unexpectedField(
    value,
    new Set(["revisions", "activeRevisionId", "actionLedger"]),
  );
  if (unexpected) return invalid("field_unexpected", unexpected);
  if (!Array.isArray(value.revisions) || value.revisions.length === 0) {
    return invalid("revisions_invalid", "revisions");
  }
  if (value.revisions.length > ASSISTANT_MESSAGE_MAX_REVISIONS) {
    return invalid("revisions_too_many", "revisions");
  }
  if (!isBoundedNonEmptyString(value.activeRevisionId, MAX_ID_CHARS)) {
    return invalid("active_revision_invalid", "activeRevisionId");
  }
  if (!Array.isArray(value.actionLedger)) {
    return invalid("ledger_invalid", "actionLedger");
  }
  if (value.actionLedger.length > ASSISTANT_MESSAGE_MAX_LEDGER_ENTRIES) {
    return invalid("ledger_too_many", "actionLedger");
  }

  const revisions: AssistantMessageRevision[] = [];
  const revisionIds = new Set<string>();
  for (let index = 0; index < value.revisions.length; index += 1) {
    const result = validateRevision(value.revisions[index], index);
    if (!result.ok) return result;
    if (revisionIds.has(result.value.revisionId)) {
      return invalid(
        "revision_id_duplicate",
        `revisions[${index}].revisionId`,
      );
    }
    revisionIds.add(result.value.revisionId);
    revisions.push(result.value);
  }
  if (!revisionIds.has(value.activeRevisionId)) {
    return invalid("active_revision_invalid", "activeRevisionId");
  }

  const indexResult = buildRevisionIndex(revisions);
  if (!indexResult.ok) return indexResult;
  const parentFailure = validateRevisionParents(revisions, indexResult.value);
  if (parentFailure) return { ok: false, reason: parentFailure };

  const actionLedger: ToolActionLedgerEntry[] = [];
  const actionRefs = new Set<string>();
  for (let index = 0; index < value.actionLedger.length; index += 1) {
    const result = validateLedgerEntry(value.actionLedger[index], index);
    if (!result.ok) return result;
    if (actionRefs.has(result.value.actionRef)) {
      return invalid(
        "action_ref_duplicate",
        `actionLedger[${index}].actionRef`,
      );
    }
    actionRefs.add(result.value.actionRef);
    actionLedger.push(result.value);
  }

  const crossFailure = validateCrossReferences(
    indexResult.value,
    actionLedger,
  );
  if (crossFailure) return { ok: false, reason: crossFailure };

  return {
    ok: true,
    value: {
      revisions,
      activeRevisionId: value.activeRevisionId,
      actionLedger,
    },
  };
}

function validateRevision(
  value: unknown,
  index: number,
): ValidationResult<AssistantMessageRevision> {
  const path = `revisions[${index}]`;
  if (!isRecord(value)) return invalid("revision_invalid", path);
  if (!isBoundedNonEmptyString(value.revisionId, MAX_ID_CHARS)) {
    return invalid("revision_id_invalid", `${path}.revisionId`);
  }
  if (value.kind === "turn") return validateTurnRevision(value, path);
  if (value.kind === "legacy") return validateLegacyRevision(value, path);
  return invalid("revision_kind_invalid", `${path}.kind`);
}

function validateTurnRevision(
  value: Record<string, unknown>,
  path: string,
): ValidationResult<AssistantMessageRevision> {
  const unexpected = unexpectedField(
    value,
    new Set([
      ...REVISION_BASE_FIELDS,
      "kind",
      "origin",
      "parentRevisionId",
      "turn",
      "replayEvidence",
    ]),
    path,
  );
  if (unexpected) return invalid("field_unexpected", unexpected);
  if (
    value.origin !== "generated" &&
    value.origin !== "regenerated" &&
    value.origin !== "edited"
  ) {
    return invalid("revision_invalid", `${path}.origin`);
  }
  if (
    !isTimestamp(value.createdAt) ||
    !isOneOf(value.provider, PROVIDERS) ||
    !isBoundedNonEmptyString(value.modelId, MAX_ID_CHARS)
  ) {
    return invalid("revision_attribution_invalid", path);
  }
  if (
    value.parentRevisionId !== undefined &&
    !isBoundedNonEmptyString(value.parentRevisionId, MAX_ID_CHARS)
  ) {
    return invalid("revision_parent_invalid", `${path}.parentRevisionId`);
  }
  const metadataFailure = validateRevisionMetadata(value, path, true);
  if (metadataFailure) return { ok: false, reason: metadataFailure };
  const turn = validateAssistantTurn(value.turn);
  if (!turn.ok) {
    return invalid(
      "turn_invalid",
      `${path}.turn.${turn.reason.path}`,
      turn.reason.code,
    );
  }
  if (
    value.replayEvidence !== undefined &&
    !isValidReplayEvidence(value.replayEvidence)
  ) {
    return invalid("revision_metadata_invalid", `${path}.replayEvidence`);
  }
  const evidenceFailure = crossCheckCaptureEvidence(value, turn.value, path);
  if (evidenceFailure) return { ok: false, reason: evidenceFailure };
  return {
    ok: true,
    value: structuredClone(value) as unknown as AssistantMessageRevision,
  };
}

/**
 * Replay evidence and per-item capture evidence were previously validated in
 * isolation, so a turn could claim exact capture while carrying an unplaced or
 * capture-invalid item. RFC-0011 makes runtime evidence authoritative: a
 * descriptor is a ceiling and a turn's own items can only lower it.
 *
 * Checked here rather than in the turn validator because the claim being
 * cross-checked lives on the revision, alongside the resume cursor it gates.
 */
function crossCheckCaptureEvidence(
  value: Record<string, unknown>,
  turn: AssistantTurnRecord,
  path: string,
): AssistantMessageInvalidReason | null {
  // Version-1 turns predate runtime placement entirely. Migration, not the
  // validator, is the funnel that gives them conservative evidence, so
  // cross-checking one here would reject every unmigrated conversation.
  if (turn.schemaVersion !== 2) return null;
  const claimed = value.replayEvidence as AssistantReplayEvidence | undefined;
  const forced = turn.quiescence === "forced";
  if (forced) {
    const usage = value.usage as MessageUsage | undefined;
    if (usage?.resumeCursor !== undefined) {
      return reason("revision_metadata_invalid", `${path}.usage.resumeCursor`);
    }
  }
  if (!claimed) return null;

  const supported = lowerEvidenceFromCapture(claimed, turn);
  if (
    supported.capabilities.captureOrder !== claimed.capabilities.captureOrder ||
    supported.capabilities.coldReplay !== claimed.capabilities.coldReplay ||
    supported.capabilities.nativeResume !== claimed.capabilities.nativeResume ||
    supported.tier !== claimed.tier
  ) {
    return reason("revision_metadata_invalid", `${path}.replayEvidence`);
  }
  return null;
}

function validateLegacyRevision(
  value: Record<string, unknown>,
  path: string,
): ValidationResult<AssistantMessageRevision> {
  const unexpected = unexpectedField(
    value,
    new Set([...REVISION_BASE_FIELDS, "kind", "content", "legacySteps"]),
    path,
  );
  if (unexpected) return invalid("field_unexpected", unexpected);
  if (!isBoundedString(value.content, MAX_CONTENT_CHARS)) {
    return invalid("legacy_content_invalid", `${path}.content`);
  }
  const metadataFailure = validateRevisionMetadata(value, path, false);
  if (metadataFailure) return { ok: false, reason: metadataFailure };
  if (
    value.legacySteps !== undefined &&
    !isValidLegacySteps(value.legacySteps)
  ) {
    return invalid("legacy_steps_invalid", `${path}.legacySteps`);
  }
  return {
    ok: true,
    value: structuredClone(value) as unknown as AssistantMessageRevision,
  };
}

const REVISION_BASE_FIELDS = [
  "revisionId",
  "createdAt",
  "provider",
  "modelId",
  "usage",
  "ragSources",
  "rewrittenQuery",
  "isError",
  "interrupted",
  "errorMessage",
] as const;

function validateRevisionMetadata(
  value: Record<string, unknown>,
  path: string,
  requiredAttribution: boolean,
): AssistantMessageInvalidReason | null {
  if (
    !requiredAttribution &&
    value.createdAt !== undefined &&
    !isTimestamp(value.createdAt)
  ) {
    return reason("revision_metadata_invalid", `${path}.createdAt`);
  }
  if (
    !requiredAttribution &&
    value.provider !== undefined &&
    !isOneOf(value.provider, PROVIDERS)
  ) {
    return reason("revision_metadata_invalid", `${path}.provider`);
  }
  if (
    !requiredAttribution &&
    value.modelId !== undefined &&
    !isBoundedNonEmptyString(value.modelId, MAX_ID_CHARS)
  ) {
    return reason("revision_metadata_invalid", `${path}.modelId`);
  }
  if (value.usage !== undefined && !isValidUsage(value.usage)) {
    return reason("revision_metadata_invalid", `${path}.usage`);
  }
  if (value.ragSources !== undefined && !isValidRagSources(value.ragSources)) {
    return reason("revision_metadata_invalid", `${path}.ragSources`);
  }
  if (
    value.rewrittenQuery !== undefined &&
    !isBoundedString(value.rewrittenQuery, ASSISTANT_ACTION_MAX_TEXT_CHARS)
  ) {
    return reason("revision_metadata_invalid", `${path}.rewrittenQuery`);
  }
  if (value.isError !== undefined && typeof value.isError !== "boolean") {
    return reason("revision_metadata_invalid", `${path}.isError`);
  }
  if (
    value.interrupted !== undefined &&
    typeof value.interrupted !== "boolean"
  ) {
    return reason("revision_metadata_invalid", `${path}.interrupted`);
  }
  if (
    value.errorMessage !== undefined &&
    !isBoundedString(value.errorMessage, ASSISTANT_ACTION_MAX_TEXT_CHARS)
  ) {
    return reason("revision_metadata_invalid", `${path}.errorMessage`);
  }
  return null;
}

function validateLedgerEntry(
  value: unknown,
  index: number,
): ValidationResult<ToolActionLedgerEntry> {
  const path = `actionLedger[${index}]`;
  if (!isRecord(value)) return invalid("ledger_invalid", path);
  const unexpected = unexpectedField(
    value,
    new Set([
      "actionRef",
      "revisionId",
      "family",
      "placement",
      "payload",
      "events",
    ]),
    path,
  );
  if (unexpected) return invalid("field_unexpected", unexpected);
  if (!isBoundedNonEmptyString(value.actionRef, MAX_ID_CHARS)) {
    return invalid("action_ref_invalid", `${path}.actionRef`);
  }
  if (!isBoundedNonEmptyString(value.revisionId, MAX_ID_CHARS)) {
    return invalid("action_revision_invalid", `${path}.revisionId`);
  }
  if (
    value.family !== "edit" &&
    value.family !== "vault_op" &&
    value.family !== "memory" &&
    value.family !== "interaction"
  ) {
    return invalid("family_invalid", `${path}.family`);
  }
  if (!isValidPlacement(value.placement)) {
    const code = placementFailureCode(value.placement);
    return invalid(code, `${path}.placement`);
  }
  if (!isValidPayload(value.family, value.payload)) {
    return invalid("payload_invalid", `${path}.payload`);
  }
  const payload = value.payload as
    | EditActionPayload
    | VaultOpActionPayload
    | MemoryActionPayload;
  if (payload.targets.length > ASSISTANT_ACTION_MAX_TARGETS) {
    return invalid("targets_too_many", `${path}.payload.targets`);
  }
  const targetIds = payload.targets.map((target) => target.targetId);
  if (new Set(targetIds).size !== targetIds.length) {
    return invalid("target_id_duplicate", `${path}.payload.targets`);
  }
  const rawEvents = asUnknownArray(value.events);
  if (!rawEvents) {
    return invalid("events_invalid", `${path}.events`);
  }
  if (rawEvents.length > ASSISTANT_ACTION_MAX_EVENTS) {
    return invalid("events_too_many", `${path}.events`);
  }
  const events: ToolActionEvent[] = [];
  const eventIds = new Set<string>();
  for (let eventIndex = 0; eventIndex < rawEvents.length; eventIndex += 1) {
    const rawEvent = rawEvents[eventIndex];
    if (!isValidEvent(rawEvent, value.family)) {
      return invalid("event_invalid", `${path}.events[${eventIndex}]`);
    }
    const validatedEvent = rawEvent as ToolActionEvent;
    if (eventIds.has(validatedEvent.eventId)) {
      return invalid(
        "event_id_duplicate",
        `${path}.events[${eventIndex}].eventId`,
      );
    }
    eventIds.add(validatedEvent.eventId);
    events.push(structuredClone(validatedEvent));
  }
  const placement = value.placement;
  if (
    placement.state === "provisional" ||
    (placement.state === "unplaced" &&
      !events.some((event) => event.type !== "proposed"))
  ) {
    return invalid("placement_invalid", `${path}.placement`);
  }

  const entry = {
    actionRef: value.actionRef,
    revisionId: value.revisionId,
    family: value.family,
    placement: structuredClone(value.placement),
    payload: structuredClone(value.payload),
    events: [],
  } as unknown as ToolActionLedgerEntry;
  let replay = entry;
  try {
    for (const event of events) replay = appendActionEvent(replay, event);
  } catch (error) {
    return invalid(
      "event_sequence_invalid",
      `${path}.events`,
      error instanceof Error ? error.message : "invalid event sequence",
    );
  }
  return { ok: true, value: replay };
}

function buildRevisionIndex(
  revisions: AssistantMessageRevision[],
):
  | { ok: true; value: RevisionIndex }
  | { ok: false; reason: AssistantMessageInvalidReason } {
  const revisionsById = new Map<string, AssistantMessageRevision>();
  const revisionOrder = new Map<string, number>();
  const itemsById: RevisionIndex["itemsById"] = new Map();
  for (let index = 0; index < revisions.length; index += 1) {
    const revision = revisions[index];
    revisionsById.set(revision.revisionId, revision);
    revisionOrder.set(revision.revisionId, index);
    if (revision.kind !== "turn") continue;
    for (const item of revision.turn.items) {
      if (itemsById.has(item.id)) {
        return {
          ok: false,
          reason: reason("item_id_duplicate", `revisions[${index}].turn.items`),
        };
      }
      itemsById.set(item.id, { revision, item, revisionIndex: index });
    }
  }
  return {
    ok: true,
    value: { revisionsById, revisionOrder, itemsById },
  };
}

function validateRevisionParents(
  revisions: AssistantMessageRevision[],
  index: RevisionIndex,
): AssistantMessageInvalidReason | null {
  for (let revisionIndex = 0; revisionIndex < revisions.length; revisionIndex += 1) {
    const revision = revisions[revisionIndex];
    if (revision.kind !== "turn") continue;
    if (revision.origin === "edited" && !revision.parentRevisionId) {
      return reason(
        "revision_parent_invalid",
        `revisions[${revisionIndex}].parentRevisionId`,
      );
    }
    if (!revision.parentRevisionId) continue;
    const parentIndex = index.revisionOrder.get(revision.parentRevisionId);
    if (parentIndex === undefined || parentIndex >= revisionIndex) {
      return reason(
        "revision_parent_invalid",
        `revisions[${revisionIndex}].parentRevisionId`,
      );
    }
  }
  return null;
}

function validateCrossReferences(
  index: RevisionIndex,
  ledger: ToolActionLedgerEntry[],
): AssistantMessageInvalidReason | null {
  const actions = new Map(
    ledger.map((entry) => [entry.actionRef, entry] as const),
  );
  for (let ledgerIndex = 0; ledgerIndex < ledger.length; ledgerIndex += 1) {
    const entry = ledger[ledgerIndex];
    const revision = index.revisionsById.get(entry.revisionId);
    if (!revision || revision.kind !== "turn") {
      return reason(
        "action_revision_invalid",
        `actionLedger[${ledgerIndex}].revisionId`,
      );
    }
    if (entry.placement.state !== "placed") continue;
    const owner = index.itemsById.get(entry.placement.itemId);
    if (
      !owner ||
      owner.revision.revisionId !== entry.revisionId ||
      owner.item.actionRef !== entry.actionRef
    ) {
      return reason(
        "placed_item_invalid",
        `actionLedger[${ledgerIndex}].placement.itemId`,
      );
    }
    if (
      entry.placement.anchor === "tool_call" &&
      (owner.item.type !== "tool_call" ||
        owner.item.toolCallId !== entry.placement.correlation.toolCallId)
    ) {
      return reason(
        "placed_item_invalid",
        `actionLedger[${ledgerIndex}].placement`,
      );
    }
    if (
      entry.placement.anchor === "parsed_edit" &&
      (owner.item.type !== "prose" ||
        owner.item.actionAnchor !== "parsed_edit" ||
        entry.family !== "edit")
    ) {
      return reason(
        "placed_item_invalid",
        `actionLedger[${ledgerIndex}].placement`,
      );
    }
  }

  for (const owner of index.itemsById.values()) {
    const sourceFailure = validateSourceItem(owner, index);
    if (sourceFailure) return sourceFailure;
    if (!owner.item.actionRef) continue;
    const entry = actions.get(owner.item.actionRef);
    if (!entry || entry.placement.state !== "placed") {
      return reason("action_reference_invalid", owner.item.id);
    }
    if (owner.revision.revisionId === entry.revisionId) {
      if (entry.placement.itemId !== owner.item.id) {
        return reason("action_reference_invalid", owner.item.id);
      }
      continue;
    }
    if (!proveActionProvenance(owner, entry, index)) {
      return reason("source_item_invalid", owner.item.id);
    }
  }
  return null;
}

function validateSourceItem(
  owner: RevisionIndex["itemsById"] extends Map<string, infer Value>
    ? Value
    : never,
  index: RevisionIndex,
): AssistantMessageInvalidReason | null {
  if (!owner.item.sourceItemId) return null;
  const source = index.itemsById.get(owner.item.sourceItemId);
  if (
    !source ||
    source.revisionIndex >= owner.revisionIndex ||
    source.item.type !== owner.item.type ||
    owner.revision.parentRevisionId !== source.revision.revisionId
  ) {
    return reason("source_item_invalid", owner.item.id);
  }
  return null;
}

function proveActionProvenance(
  start: RevisionIndex["itemsById"] extends Map<string, infer Value>
    ? Value
    : never,
  entry: ToolActionLedgerEntry,
  index: RevisionIndex,
): boolean {
  let current = start;
  const seen = new Set<string>();
  while (current.item.sourceItemId) {
    if (seen.has(current.item.id)) return false;
    seen.add(current.item.id);
    const source = index.itemsById.get(current.item.sourceItemId);
    if (
      !source ||
      source.revisionIndex >= current.revisionIndex ||
      source.item.type !== current.item.type ||
      source.item.actionRef !== entry.actionRef ||
      current.revision.parentRevisionId !== source.revision.revisionId
    ) {
      return false;
    }
    if (
      source.revision.revisionId === entry.revisionId &&
      entry.placement.state === "placed" &&
      source.item.id === entry.placement.itemId
    ) {
      return true;
    }
    current = source;
  }
  return false;
}

function isValidPlacement(value: unknown): value is ToolActionPlacement {
  if (!isRecord(value)) return false;
  if (value.state === "provisional") {
    return (
      unexpectedField(value, new Set(["state", "correlation"])) === null &&
      isExactCorrelation(value.correlation)
    );
  }
  if (value.state === "placed" && value.anchor === "tool_call") {
    return (
      unexpectedField(
        value,
        new Set(["state", "anchor", "itemId", "correlation"]),
      ) === null &&
      isBoundedNonEmptyString(value.itemId, MAX_ID_CHARS) &&
      isExactCorrelation(value.correlation)
    );
  }
  if (value.state === "placed" && value.anchor === "parsed_edit") {
    return (
      unexpectedField(value, new Set(["state", "anchor", "itemId"])) === null &&
      isBoundedNonEmptyString(value.itemId, MAX_ID_CHARS)
    );
  }
  if (value.state === "unplaced") {
    return (
      unexpectedField(
        value,
        new Set(["state", "correlation", "reason"]),
      ) === null &&
      isCorrelation(value.correlation) &&
      (value.reason === "declaration_missing" ||
        value.reason === "correlation_unavailable")
    );
  }
  return false;
}

function placementFailureCode(
  value: unknown,
): "placement_invalid" | "correlation_invalid" {
  if (isRecord(value) && "correlation" in value && !isCorrelation(value.correlation)) {
    return "correlation_invalid";
  }
  return "placement_invalid";
}

function isExactCorrelation(
  value: unknown,
): value is Extract<
  ToolActionCorrelationEvidence,
  { kind: "provider_id" | "plugin_id" }
> {
  return (
    isRecord(value) &&
    unexpectedField(value, new Set(["kind", "toolCallId"])) === null &&
    (value.kind === "provider_id" || value.kind === "plugin_id") &&
    isBoundedNonEmptyString(value.toolCallId, MAX_ID_CHARS)
  );
}

function isCorrelation(
  value: unknown,
): value is ToolActionCorrelationEvidence {
  if (isExactCorrelation(value)) return true;
  return (
    isRecord(value) &&
    unexpectedField(value, new Set(["kind", "transport", "reason"])) === null &&
    value.kind === "none" &&
    isBoundedNonEmptyString(value.transport, ASSISTANT_ACTION_MAX_TEXT_CHARS) &&
    isBoundedNonEmptyString(value.reason, ASSISTANT_ACTION_MAX_TEXT_CHARS)
  );
}

function isValidPayload(
  family: ToolActionLedgerEntry["family"],
  value: unknown,
): boolean {
  if (!isRecord(value) || !Array.isArray(value.targets)) return false;
  if (value.targets.length > ASSISTANT_ACTION_MAX_TARGETS) return false;
  if (family === "edit") {
    return (
      unexpectedField(value, new Set(["proposalId", "targets"])) === null &&
      isBoundedNonEmptyString(value.proposalId, MAX_ID_CHARS) &&
      value.targets.every(isValidEditTarget)
    );
  }
  if (family === "vault_op") {
    return (
      unexpectedField(
        value,
        new Set(["proposalId", "createdAt", "targets"]),
      ) === null &&
      isBoundedNonEmptyString(value.proposalId, MAX_ID_CHARS) &&
      isTimestamp(value.createdAt) &&
      value.targets.every(isValidVaultTarget)
    );
  }
  if (family === "memory") {
    return (
      unexpectedField(value, new Set(["targets"])) === null &&
      value.targets.every(isValidMemoryTarget)
    );
  }
  return (
    unexpectedField(value, new Set(["kind", "targets"])) === null &&
    value.kind === "ask_user" &&
    value.targets.every(isValidInteractionTarget)
  );
}

function isValidEditTarget(value: unknown): boolean {
  return (
    isRecord(value) &&
    unexpectedField(
      value,
      new Set([
        "targetId",
        "targetFilePath",
        "documentSnapshot",
        "snapshotTimestamp",
        "resolvedEdit",
      ]),
    ) === null &&
    isBoundedNonEmptyString(value.targetId, MAX_ID_CHARS) &&
    isBoundedString(value.targetFilePath, MAX_PATH_CHARS) &&
    isBoundedString(value.documentSnapshot, ASSISTANT_ACTION_MAX_SNAPSHOT_CHARS) &&
    isTimestamp(value.snapshotTimestamp) &&
    isValidResolvedEdit(value.resolvedEdit)
  );
}

function isValidVaultTarget(value: unknown): boolean {
  return (
    isRecord(value) &&
    unexpectedField(
      value,
      new Set([
        "targetId",
        "operation",
        "gate",
        "summary",
        "linkImpact",
      ]),
    ) === null &&
    isBoundedNonEmptyString(value.targetId, MAX_ID_CHARS) &&
    isValidVaultOperation(value.operation) &&
    (value.gate === "auto" || value.gate === "ask") &&
    isBoundedString(value.summary, ASSISTANT_ACTION_MAX_TEXT_CHARS) &&
    (value.linkImpact === undefined || isNonNegativeInteger(value.linkImpact))
  );
}

function isValidMemoryTarget(value: unknown): boolean {
  if (
    !isRecord(value) ||
    unexpectedField(value, new Set(["targetId", "mutation"])) !== null ||
    !isBoundedNonEmptyString(value.targetId, MAX_ID_CHARS) ||
    !isRecord(value.mutation)
  ) {
    return false;
  }
  if (value.mutation.kind === "add") {
    return (
      unexpectedField(value.mutation, new Set(["kind", "memory"])) === null &&
      isValidMemory(value.mutation.memory)
    );
  }
  return (
    value.mutation.kind === "forget" &&
    unexpectedField(value.mutation, new Set(["kind", "name"])) === null &&
    isBoundedNonEmptyString(
      value.mutation.name,
      ASSISTANT_ACTION_MAX_TEXT_CHARS,
    )
  );
}

function isValidInteractionTarget(value: unknown): boolean {
  return (
    isRecord(value) &&
    unexpectedField(
      value,
      new Set([
        "targetId",
        "question",
        "header",
        "options",
        "multiSelect",
      ]),
    ) === null &&
    isBoundedNonEmptyString(value.targetId, MAX_ID_CHARS) &&
    isBoundedNonEmptyString(value.question, ASSISTANT_ACTION_MAX_TEXT_CHARS) &&
    isBoundedNonEmptyString(value.header, ASSISTANT_ACTION_MAX_TEXT_CHARS) &&
    Array.isArray(value.options) &&
    value.options.length <= MAX_OPTIONS &&
    value.options.every((option) =>
      isBoundedString(option, ASSISTANT_ACTION_MAX_TEXT_CHARS),
    ) &&
    typeof value.multiSelect === "boolean"
  );
}

function isValidEvent(
  value: unknown,
  family: ToolActionLedgerEntry["family"],
): boolean {
  if (
    !isRecord(value) ||
    !isBoundedNonEmptyString(value.eventId, MAX_ID_CHARS) ||
    !isBoundedNonEmptyString(value.targetId, MAX_ID_CHARS) ||
    !isTimestamp(value.createdAt)
  ) {
    return false;
  }
  const base = ["eventId", "type", "targetId", "createdAt"];
  if (
    value.type === "proposed" ||
    value.type === "approved" ||
    value.type === "retry_requested"
  ) {
    return unexpectedField(value, new Set(base)) === null;
  }
  if (value.type === "declined") {
    return (
      unexpectedField(value, new Set([...base, "reason"])) === null &&
      (value.reason === undefined ||
        isBoundedString(value.reason, ASSISTANT_ACTION_MAX_TEXT_CHARS))
    );
  }
  if (value.type === "apply_succeeded") {
    return (
      unexpectedField(value, new Set([...base, "effect"])) === null &&
      isValidEffect(value.effect, family)
    );
  }
  if (value.type === "apply_failed") {
    return (
      unexpectedField(value, new Set([...base, "error"])) === null &&
      isBoundedString(value.error, ASSISTANT_ACTION_MAX_TEXT_CHARS)
    );
  }
  if (value.type === "undo_succeeded") {
    return (
      unexpectedField(value, new Set([...base, "undo"])) === null &&
      isValidUndo(value.undo, family)
    );
  }
  if (value.type === "undo_refused") {
    return (
      unexpectedField(value, new Set([...base, "reason"])) === null &&
      isBoundedString(value.reason, ASSISTANT_ACTION_MAX_TEXT_CHARS)
    );
  }
  // Write-ahead audit evidence (RFC-0011). Both carry the intent identity that
  // links the persisted pre-effect record to this ledger entry.
  if (value.type === "intent_recorded") {
    return (
      unexpectedField(value, new Set([...base, "intentId"])) === null &&
      isBoundedNonEmptyString(value.intentId, MAX_ID_CHARS)
    );
  }
  if (value.type === "outcome_unknown") {
    return (
      unexpectedField(value, new Set([...base, "intentId", "reason"])) === null &&
      isBoundedNonEmptyString(value.intentId, MAX_ID_CHARS) &&
      isBoundedString(value.reason, ASSISTANT_ACTION_MAX_TEXT_CHARS)
    );
  }
  return (
    value.type === "superseded" &&
    unexpectedField(
      value,
      new Set([...base, "replacementRevisionId"]),
    ) === null &&
    isBoundedNonEmptyString(value.replacementRevisionId, MAX_ID_CHARS)
  );
}

function isValidEffect(
  value: unknown,
  family: ToolActionLedgerEntry["family"],
): value is ToolActionEffectRecord {
  if (!isRecord(value) || value.family !== family) return false;
  if (family === "edit") {
    return (
      unexpectedField(
        value,
        new Set([
          "family",
          "targetFilePath",
          "preApplySnapshot",
          "postApplySnapshot",
          "appliedAt",
        ]),
      ) === null &&
      isBoundedString(value.targetFilePath, MAX_PATH_CHARS) &&
      isBoundedString(value.preApplySnapshot, ASSISTANT_ACTION_MAX_SNAPSHOT_CHARS) &&
      isBoundedString(value.postApplySnapshot, ASSISTANT_ACTION_MAX_SNAPSHOT_CHARS) &&
      isTimestamp(value.appliedAt)
    );
  }
  if (family === "vault_op") {
    return (
      unexpectedField(
        value,
        new Set(["family", "operation", "inverse", "appliedAt"]),
      ) === null &&
      isValidVaultOperation(value.operation) &&
      (value.inverse === null || isValidVaultOperation(value.inverse)) &&
      isTimestamp(value.appliedAt)
    );
  }
  if (family === "memory") {
    return (
      unexpectedField(
        value,
        new Set(["family", "before", "after", "appliedAt"]),
      ) === null &&
      (value.before === null || isValidMemory(value.before)) &&
      (value.after === null || isValidMemory(value.after)) &&
      isTimestamp(value.appliedAt)
    );
  }
  return (
    unexpectedField(
      value,
      new Set(["family", "guidance", "completedAt"]),
    ) === null &&
    isValidGuidance(value.guidance) &&
    isTimestamp(value.completedAt)
  );
}

function isValidUndo(
  value: unknown,
  family: ToolActionLedgerEntry["family"],
): value is ToolActionUndoRecord {
  if (!isRecord(value) || value.family !== family) return false;
  if (family === "edit") {
    return (
      unexpectedField(
        value,
        new Set([
          "family",
          "targetFilePath",
          "restoredSnapshot",
          "undoneAt",
        ]),
      ) === null &&
      isBoundedString(value.targetFilePath, MAX_PATH_CHARS) &&
      isBoundedString(value.restoredSnapshot, ASSISTANT_ACTION_MAX_SNAPSHOT_CHARS) &&
      isTimestamp(value.undoneAt)
    );
  }
  if (family === "vault_op") {
    return (
      unexpectedField(
        value,
        new Set(["family", "inverse", "undoneAt"]),
      ) === null &&
      (value.inverse === null || isValidVaultOperation(value.inverse)) &&
      isTimestamp(value.undoneAt)
    );
  }
  return (
    family === "memory" &&
    unexpectedField(
      value,
      new Set(["family", "restored", "undoneAt"]),
    ) === null &&
    (value.restored === null || isValidMemory(value.restored)) &&
    isTimestamp(value.undoneAt)
  );
}

function isValidResolvedEdit(value: unknown): value is ResolvedEdit {
  if (!isRecord(value)) return false;
  return (
    unexpectedField(
      value,
      new Set([
        "id",
        "editBlock",
        "matchOffset",
        "matchLength",
        "matchedText",
        "startLine",
        "endLine",
        "contextBefore",
        "contextAfter",
        "confidence",
        "matchType",
        "nearMiss",
        "occurrenceCount",
      ]),
    ) === null &&
    isBoundedNonEmptyString(value.id, MAX_ID_CHARS) &&
    isValidEditBlock(value.editBlock) &&
    isNonNegativeInteger(value.matchOffset) &&
    isNonNegativeInteger(value.matchLength) &&
    isBoundedString(value.matchedText, ASSISTANT_ACTION_MAX_SNAPSHOT_CHARS) &&
    isNonNegativeInteger(value.startLine) &&
    isNonNegativeInteger(value.endLine) &&
    isStringArray(value.contextBefore, ASSISTANT_ACTION_MAX_TEXT_CHARS) &&
    isStringArray(value.contextAfter, ASSISTANT_ACTION_MAX_TEXT_CHARS) &&
    typeof value.confidence === "number" &&
    Number.isFinite(value.confidence) &&
    (value.matchType === "exact" ||
      value.matchType === "whitespace" ||
      value.matchType === "fuzzy" ||
      value.matchType === "none") &&
    (value.nearMiss === undefined || typeof value.nearMiss === "boolean") &&
    (value.occurrenceCount === undefined ||
      isNonNegativeInteger(value.occurrenceCount))
  );
}

function isValidEditBlock(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    unexpectedField(
      value,
      new Set([
        "id",
        "searchText",
        "replaceText",
        "rawBlock",
        "targetPath",
        "toolName",
        "toolArgs",
      ]),
    ) === null &&
    isBoundedNonEmptyString(value.id, MAX_ID_CHARS) &&
    isBoundedString(value.searchText, ASSISTANT_ACTION_MAX_SNAPSHOT_CHARS) &&
    isBoundedString(value.replaceText, ASSISTANT_ACTION_MAX_SNAPSHOT_CHARS) &&
    isBoundedString(value.rawBlock, ASSISTANT_ACTION_MAX_SNAPSHOT_CHARS) &&
    (value.targetPath === undefined ||
      isBoundedString(value.targetPath, MAX_PATH_CHARS)) &&
    (value.toolName === undefined ||
      value.toolName === "update_frontmatter" ||
      value.toolName === "insert_into_note") &&
    (value.toolArgs === undefined || isBoundedJson(value.toolArgs))
  );
}

function isValidVaultOperation(value: unknown): value is VaultOperation {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "create") {
    return exactStrings(value, ["kind", "path", "content"], ["path", "content"]);
  }
  if (value.kind === "overwrite") {
    return (
      exact(value, ["kind", "path", "content", "expect"]) &&
      isBoundedString(value.path, MAX_PATH_CHARS) &&
      isBoundedString(value.content, ASSISTANT_ACTION_MAX_SNAPSHOT_CHARS) &&
      isValidFingerprint(value.expect)
    );
  }
  if (value.kind === "createDir") {
    return (
      exact(value, ["kind", "path", "subtree"]) &&
      isBoundedString(value.path, MAX_PATH_CHARS) &&
      (value.subtree === undefined || isStringArray(value.subtree, MAX_PATH_CHARS))
    );
  }
  if (value.kind === "move") {
    return (
      exact(value, ["kind", "from", "to", "expect"]) &&
      isBoundedString(value.from, MAX_PATH_CHARS) &&
      isBoundedString(value.to, MAX_PATH_CHARS) &&
      isValidFingerprint(value.expect)
    );
  }
  if (value.kind === "trash") {
    return (
      exact(value, ["kind", "path", "expect", "snapshot"]) &&
      isBoundedString(value.path, MAX_PATH_CHARS) &&
      isValidFingerprint(value.expect) &&
      isBoundedString(value.snapshot, ASSISTANT_ACTION_MAX_SNAPSHOT_CHARS)
    );
  }
  if (value.kind === "moveFolder") {
    return exactStrings(value, ["kind", "from", "to"], ["from", "to"]);
  }
  if (value.kind === "trashFolder") {
    return exactStrings(value, ["kind", "path"], ["path"]);
  }
  if (value.kind !== "replaceInVault") return false;
  return (
    exact(
      value,
      [
        "kind",
        "search",
        "replace",
        "caseSensitive",
        "wholeWord",
        "targets",
        "occurrences",
      ],
    ) &&
    isBoundedString(value.search, ASSISTANT_ACTION_MAX_TEXT_CHARS) &&
    isBoundedString(value.replace, ASSISTANT_ACTION_MAX_TEXT_CHARS) &&
    typeof value.caseSensitive === "boolean" &&
    typeof value.wholeWord === "boolean" &&
    Array.isArray(value.targets) &&
    value.targets.length <= ASSISTANT_ACTION_MAX_TARGETS &&
    value.targets.every(isValidVaultReplaceTarget) &&
    isNonNegativeInteger(value.occurrences)
  );
}

function isValidVaultReplaceTarget(value: unknown): boolean {
  return (
    isRecord(value) &&
    exact(value, ["path", "content", "expect", "count"]) &&
    isBoundedString(value.path, MAX_PATH_CHARS) &&
    isBoundedString(value.content, ASSISTANT_ACTION_MAX_SNAPSHOT_CHARS) &&
    isValidFingerprint(value.expect) &&
    (value.count === undefined || isNonNegativeInteger(value.count))
  );
}

function isValidFingerprint(value: unknown): boolean {
  return (
    isRecord(value) &&
    exact(value, ["mtime", "size"]) &&
    typeof value.mtime === "number" &&
    Number.isFinite(value.mtime) &&
    isNonNegativeInteger(value.size)
  );
}

function isValidMemory(value: unknown): value is Memory {
  return (
    isRecord(value) &&
    exact(value, ["name", "type", "description", "content", "enabled"]) &&
    isBoundedNonEmptyString(value.name, ASSISTANT_ACTION_MAX_TEXT_CHARS) &&
    (value.type === "rule" || value.type === "context") &&
    isBoundedString(value.description, ASSISTANT_ACTION_MAX_TEXT_CHARS) &&
    (value.content === undefined ||
      isBoundedString(value.content, ASSISTANT_ACTION_MAX_SNAPSHOT_CHARS)) &&
    typeof value.enabled === "boolean"
  );
}

function isValidGuidance(
  value: unknown,
): value is CompletedAskGuidanceRecord {
  if (
    !isRecord(value) ||
    !exact(value, ["questions"]) ||
    !Array.isArray(value.questions) ||
    value.questions.length === 0 ||
    value.questions.length > MAX_OPTIONS
  ) {
    return false;
  }
  return value.questions.every(
    (question) =>
      isRecord(question) &&
      exact(question, ["question", "header", "answer"]) &&
      isBoundedNonEmptyString(
        question.question,
        ASSISTANT_ACTION_MAX_TEXT_CHARS,
      ) &&
      isBoundedNonEmptyString(
        question.header,
        ASSISTANT_ACTION_MAX_TEXT_CHARS,
      ) &&
      (isBoundedString(question.answer, ASSISTANT_ACTION_MAX_TEXT_CHARS) ||
        (Array.isArray(question.answer) &&
          question.answer.length <= MAX_OPTIONS &&
          question.answer.every((answer) =>
            isBoundedString(answer, ASSISTANT_ACTION_MAX_TEXT_CHARS),
          )))
  );
}

function isValidUsage(value: unknown): value is MessageUsage {
  if (!isRecord(value)) return false;
  const fields = new Set([
    "inputTokens",
    "outputTokens",
    "cacheCreationInputTokens",
    "cacheReadInputTokens",
    "estimatedCostUsd",
    "sessionReused",
    "sessionResumed",
    "sessionRebuildReason",
    "resumeCursor",
    "contextTokens",
    "contextWindow",
  ]);
  if (unexpectedField(value, fields) !== null) return false;
  if (
    !isNonNegativeNumber(value.inputTokens) ||
    !isNonNegativeNumber(value.outputTokens)
  ) {
    return false;
  }
  for (const field of [
    "cacheCreationInputTokens",
    "cacheReadInputTokens",
    "estimatedCostUsd",
    "contextTokens",
    "contextWindow",
  ]) {
    if (value[field] !== undefined && !isNonNegativeNumber(value[field])) {
      return false;
    }
  }
  if (
    value.sessionReused !== undefined &&
    typeof value.sessionReused !== "boolean"
  ) {
    return false;
  }
  if (
    value.sessionResumed !== undefined &&
    typeof value.sessionResumed !== "boolean"
  ) {
    return false;
  }
  if (
    value.sessionRebuildReason !== undefined &&
    !isBoundedNonEmptyString(value.sessionRebuildReason, MAX_ID_CHARS)
  ) {
    return false;
  }
  return value.resumeCursor === undefined || isValidResumeCursor(value.resumeCursor);
}

function isValidResumeCursor(value: unknown): boolean {
  return (
    isRecord(value) &&
    exact(
      value,
      ["sessionId", "coveredCount", "prefixHash", "configFingerprint"],
    ) &&
    isBoundedNonEmptyString(value.sessionId, MAX_ID_CHARS) &&
    isNonNegativeInteger(value.coveredCount) &&
    isBoundedNonEmptyString(value.prefixHash, MAX_ID_CHARS) &&
    isBoundedNonEmptyString(value.configFingerprint, MAX_ID_CHARS)
  );
}

function isValidRagSources(value: unknown): value is RagSourceRef[] {
  return (
    Array.isArray(value) &&
    value.length <= ASSISTANT_ACTION_MAX_TARGETS &&
    value.every(
      (source) =>
        isRecord(source) &&
        exact(source, [
          "filePath",
          "headingPath",
          "score",
          "content",
          "graphContext",
        ]) &&
        isBoundedString(source.filePath, MAX_PATH_CHARS) &&
        isBoundedString(source.headingPath, MAX_PATH_CHARS) &&
        typeof source.score === "number" &&
        Number.isFinite(source.score) &&
        (source.content === undefined ||
          isBoundedString(source.content, ASSISTANT_ACTION_MAX_SNAPSHOT_CHARS)) &&
        (source.graphContext === undefined ||
          isBoundedJson(source.graphContext))
    )
  );
}

function isValidReplayEvidence(value: unknown): value is AssistantReplayEvidence {
  if (
    !isRecord(value) ||
    !exact(value, ["tier", "capabilities", "loweredReason"]) ||
    (value.tier !== "native" &&
      value.tier !== "structural" &&
      value.tier !== "textual") ||
    !isRecord(value.capabilities)
  ) {
    return false;
  }
  const capabilities = value.capabilities;
  return (
    exact(capabilities, [
      "captureOrder",
      "toolCorrelation",
      "coldReplay",
      "nativeResume",
    ]) &&
    (capabilities.captureOrder === "exact" ||
      capabilities.captureOrder === "segment" ||
      capabilities.captureOrder === "text_only") &&
    (capabilities.toolCorrelation === "provider_id" ||
      capabilities.toolCorrelation === "plugin_id" ||
      capabilities.toolCorrelation === "none") &&
    (capabilities.coldReplay === "structural" ||
      capabilities.coldReplay === "textual") &&
    typeof capabilities.nativeResume === "boolean" &&
    (value.loweredReason === undefined ||
      isBoundedString(value.loweredReason, ASSISTANT_ACTION_MAX_TEXT_CHARS))
  );
}

function isValidLegacySteps(value: unknown): value is AgenticStep[] {
  if (!Array.isArray(value) || value.length > ASSISTANT_ACTION_MAX_EVENTS) {
    return false;
  }
  return value.every(
    (step) =>
      isRecord(step) &&
      exact(step, [
        "type",
        "round",
        "toolName",
        "toolCallId",
        "toolInput",
        "toolArgs",
        "isError",
        "errorContent",
        "text",
        "disposition",
        "resultDigest",
        "resultRecord",
        "askGuidance",
        "askStatus",
      ]) &&
      (step.type === "tool_call" || step.type === "reasoning") &&
      isNonNegativeInteger(step.round) &&
      isBoundedJson(step)
  );
}

function isBoundedJson(value: unknown): boolean {
  if (!isJsonValue(value, 0, new Set<object>())) return false;
  try {
    return JSON.stringify(value).length <= ASSISTANT_ACTION_MAX_SNAPSHOT_CHARS;
  } catch {
    return false;
  }
}

function isJsonValue(
  value: unknown,
  depth: number,
  seen: Set<object>,
): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (
    typeof value !== "object" ||
    depth > MAX_JSON_DEPTH ||
    seen.has(value)
  ) {
    return false;
  }
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonValue(entry, depth + 1, seen))
    : Object.values(value).every((entry) =>
        isJsonValue(entry, depth + 1, seen),
      );
  seen.delete(value);
  return valid;
}

function exactStrings(
  value: Record<string, unknown>,
  fields: string[],
  stringFields: string[],
): boolean {
  return (
    exact(value, fields) &&
    stringFields.every((field) => {
      const bound =
        field === "content"
          ? ASSISTANT_ACTION_MAX_SNAPSHOT_CHARS
          : MAX_PATH_CHARS;
      return isBoundedString(value[field], bound);
    })
  );
}

function exact(
  value: Record<string, unknown>,
  fields: string[],
): boolean {
  return unexpectedField(value, new Set(fields)) === null;
}

function isStringArray(value: unknown, maxChars: number): boolean {
  return (
    Array.isArray(value) &&
    value.length <= ASSISTANT_ACTION_MAX_TARGETS &&
    value.every((entry) => isBoundedString(entry, maxChars))
  );
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
  );
}

function isBoundedNonEmptyString(
  value: unknown,
  maxLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength
  );
}

function isBoundedString(
  value: unknown,
  maxLength: number,
): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function isOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return (
    typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
  );
}

function unexpectedField(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  basePath = "",
): string | null {
  const field = Object.keys(value).find((key) => !allowed.has(key));
  if (field === undefined) return null;
  return basePath.length === 0 ? field : `${basePath}.${field}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asUnknownArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? (value as unknown[]) : null;
}

function invalid<T = ValidatedAssistantMessageState>(
  code: AssistantMessageInvalidReasonCode,
  path: string,
  detail?: string,
): ValidationResult<T> {
  return { ok: false, reason: reason(code, path, detail) };
}

function reason(
  code: AssistantMessageInvalidReasonCode,
  path: string,
  detail?: string,
): AssistantMessageInvalidReason {
  return { code, path, ...(detail === undefined ? {} : { detail }) };
}

import type {
  AssistantMessageRevision,
  AssistantTurnItem,
  AssistantTurnRecord,
  AssistantTurnRevision,
  InFlightGenerationAudit,
  ToolActionCorrelationEvidence,
  ToolActionFamily,
} from "../../shared/types";
import {
  lowerEvidenceFromCapture,
  migratedCaptureEvidence,
} from "../../shared/captureEvidence";
import { PROVIDER_OPTIONS } from "../../shared/modelKeys";

/**
 * Version-1 to version-2 turn migration (ADR-0031, ADR-0032).
 *
 * Migration is conservative by construction: it never invents a provider block
 * index. A version-1 item inherits `segment` placement only when its persisted
 * segment carries an exact provider-message ID, and `unplaced` otherwise. It
 * then lowers the revision's replay evidence to what that placement actually
 * supports, because a migrated turn cannot keep an exact or native claim its
 * evidence does not back.
 *
 * This runs in memory at load time. It does not rewrite conversation files;
 * a migrated shape reaches disk only through an existing explicit save path.
 */

/** Upgrades one turn revision in place-free fashion, or returns it unchanged. */
export function migrateTurnRevisionToVersion2(
  revision: AssistantTurnRevision,
): AssistantTurnRevision {
  if (revision.turn.schemaVersion === 2) return revision;

  const providerMessageIdBySegment = new Map<string, string>();
  for (const segment of revision.turn.segments) {
    if (segment.providerMessageId !== undefined) {
      providerMessageIdBySegment.set(segment.id, segment.providerMessageId);
    }
  }

  const turn: AssistantTurnRecord = {
    ...revision.turn,
    schemaVersion: 2,
    items: revision.turn.items.map((item) =>
      withMigratedEvidence(
        item,
        revision.turn.id,
        providerMessageIdBySegment.get(item.segmentId),
      ),
    ),
  };

  return {
    ...revision,
    turn,
    ...(revision.replayEvidence === undefined
      ? {}
      : { replayEvidence: lowerEvidenceFromCapture(revision.replayEvidence, turn) }),
  };
}

function withMigratedEvidence(
  item: AssistantTurnItem,
  turnId: string,
  providerMessageId: string | undefined,
): AssistantTurnItem {
  return {
    ...item,
    captureEvidence: migratedCaptureEvidence(turnId, providerMessageId),
  };
}

/** Applies {@link migrateTurnRevisionToVersion2} across a message's revisions. */
export function migrateRevisions(
  revisions: readonly AssistantMessageRevision[],
): AssistantMessageRevision[] {
  return revisions.map((revision) =>
    revision.kind === "turn" ? migrateTurnRevisionToVersion2(revision) : revision,
  );
}

const AUDIT_FAMILIES: readonly ToolActionFamily[] = [
  "edit",
  "vault_op",
  "memory",
  "interaction",
];
const AUDIT_OUTCOMES = ["pending", "resolved", "unknown"] as const;

/**
 * Reads a persisted in-flight generation audit, or returns null.
 *
 * An orphaned audit is evidence that a generation never finished, so a
 * malformed one is dropped rather than repaired: inventing a target or an
 * outcome would be worse than losing the record. A surviving unresolved intent
 * becomes one terminal `outcome_unknown` event (ADR-0033).
 */
export function normalizeInFlightGenerationAudit(
  value: unknown,
): InFlightGenerationAudit | null {
  if (!isRecord(value)) return null;
  if (
    !isNonEmptyString(value.messageId) ||
    !isNonEmptyString(value.leaseId) ||
    !isNonEmptyString(value.turnId) ||
    !isOrdinal(value.attemptOrdinal) ||
    !isOneOf(value.provider, PROVIDER_OPTIONS) ||
    !isNonEmptyString(value.modelId) ||
    !isTimestamp(value.openedAt) ||
    !Array.isArray(value.intents)
  ) {
    return null;
  }

  // Every intent that parses is kept. These records are the only evidence that
  // irreversible work happened before a generation died, so there is no count at
  // which discarding or truncating one is the better answer.
  const intents: InFlightGenerationAudit["intents"] = [];
  const seen = new Set<string>();
  for (const raw of value.intents) {
    if (!isRecord(raw)) return null;
    if (
      !isNonEmptyString(raw.intentId) ||
      seen.has(raw.intentId) ||
      !isNonEmptyString(raw.actionRef) ||
      !isOneOf(raw.family, AUDIT_FAMILIES) ||
      !isNonEmptyString(raw.targetId) ||
      !isNonEmptyString(raw.summary) ||
      !isTimestamp(raw.recordedAt) ||
      !isOneOf(raw.outcome, AUDIT_OUTCOMES) ||
      !isValidCorrelation(raw.correlation)
    ) {
      return null;
    }
    seen.add(raw.intentId);
    intents.push({
      intentId: raw.intentId,
      actionRef: raw.actionRef,
      family: raw.family,
      targetId: raw.targetId,
      correlation: raw.correlation,
      summary: raw.summary,
      recordedAt: raw.recordedAt,
      outcome: raw.outcome,
    });
  }

  return {
    messageId: value.messageId,
    leaseId: value.leaseId,
    turnId: value.turnId,
    attemptOrdinal: value.attemptOrdinal,
    provider: value.provider,
    modelId: value.modelId,
    openedAt: value.openedAt,
    intents,
  };
}

function isValidCorrelation(
  value: unknown,
): value is ToolActionCorrelationEvidence {
  if (!isRecord(value)) return false;
  if (value.kind === "provider_id" || value.kind === "plugin_id") {
    return isNonEmptyString(value.toolCallId);
  }
  return (
    value.kind === "none" &&
    isNonEmptyString(value.transport) &&
    isNonEmptyString(value.reason)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Attempt ordinals are 1-based, but 0 is a real state: no provider attempt was
 * open when the intent was written. Requiring `> 0` would
 * silently dropped exactly that record, and dropping the only evidence that an
 * irreversible action was authorized is forbidden by ADR-0033.
 */
function isOrdinal(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

import type {
  AssistantReplayEvidence,
  AssistantTurnItem,
  AssistantTurnRecord,
  ProviderItemCaptureEvidence,
  ProviderItemPlacement,
} from "./types";

/**
 * Pure derivations over per-item capture evidence (RFC-0011).
 *
 * A provider descriptor is a capability ceiling. Runtime evidence is the source
 * of truth for one turn and can only lower that ceiling. Everything here is a
 * projection of already-recorded facts: nothing infers placement, and nothing
 * upgrades fidelity.
 */

/** Ordered weakest to strongest, so the minimum over items is the turn's floor. */
const PLACEMENT_RANK: Record<ProviderItemPlacement["kind"], number> = {
  unplaced: 0,
  segment: 1,
  exact: 2,
};

export interface CaptureValiditySummary {
  items: number;
  /** Items with no `captureEvidence` at all, i.e. version-1 shapes in memory. */
  unevidenced: number;
  exact: number;
  segment: number;
  unplaced: number;
  captureInvalid: number;
}

export function summarizeCaptureValidity(
  turn: Pick<AssistantTurnRecord, "items">,
): CaptureValiditySummary {
  const summary: CaptureValiditySummary = {
    items: turn.items.length,
    unevidenced: 0,
    exact: 0,
    segment: 0,
    unplaced: 0,
    captureInvalid: 0,
  };
  for (const item of turn.items) {
    const evidence = item.captureEvidence;
    if (!evidence) {
      summary.unevidenced += 1;
      continue;
    }
    if (evidence.validity === "capture_invalid") summary.captureInvalid += 1;
    summary[evidence.placement.kind] += 1;
  }
  return summary;
}

/**
 * The weakest placement any item carries, which is the strongest placement the
 * turn as a whole may claim. An item with no evidence is treated as `unplaced`:
 * absence of a claim is never an exact claim.
 */
export function turnPlacementFloor(
  turn: Pick<AssistantTurnRecord, "items">,
): ProviderItemPlacement["kind"] {
  let floor: ProviderItemPlacement["kind"] = "exact";
  for (const item of turn.items) {
    const kind = item.captureEvidence?.placement.kind ?? "unplaced";
    if (PLACEMENT_RANK[kind] < PLACEMENT_RANK[floor]) floor = kind;
  }
  return floor;
}

/** Whether any item was retained for honesty rather than as valid capture. */
export function hasCaptureInvalidItem(
  turn: Pick<AssistantTurnRecord, "items">,
): boolean {
  return turn.items.some(
    (item) => item.captureEvidence?.validity === "capture_invalid",
  );
}

/**
 * Whether an item may be replayed back to a provider.
 *
 * Capture-invalid items and unplaced items are excluded from structural and
 * textual provider replay: the first because its position is known to be wrong,
 * the second because it makes no ordering claim to reproduce.
 */
export function isReplayableItem(item: AssistantTurnItem): boolean {
  const evidence = item.captureEvidence;
  if (!evidence) return true;
  return (
    evidence.validity === "valid" && evidence.placement.kind !== "unplaced"
  );
}

/**
 * Lowers descriptor-derived evidence to what this turn's runtime facts actually
 * support. Never raises anything.
 *
 * A `segment` or `unplaced` item forbids exact capture and native replay. A
 * capture-invalid item additionally forbids structural cold replay, because the
 * turn no longer describes the provider's own transcript. Forced quiescence
 * forbids native resume outright.
 */
export function lowerEvidenceFromCapture(
  evidence: AssistantReplayEvidence,
  turn: Pick<AssistantTurnRecord, "items" | "quiescence">,
): AssistantReplayEvidence {
  const floor = turnPlacementFloor(turn);
  const invalid = hasCaptureInvalidItem(turn);
  const forced = turn.quiescence === "forced";
  if (floor === "exact" && !invalid && !forced) return evidence;

  const captureOrder =
    floor === "exact"
      ? evidence.capabilities.captureOrder
      : floor === "segment"
        ? weakestOf(evidence.capabilities.captureOrder, "segment")
        : "text_only";
  const coldReplay = invalid ? "textual" : evidence.capabilities.coldReplay;
  const nativeResume =
    evidence.capabilities.nativeResume && !invalid && !forced && floor === "exact";
  const tier =
    nativeResume && evidence.tier === "native"
      ? "native"
      : coldReplay === "structural" && evidence.tier !== "textual"
        ? "structural"
        : "textual";

  return {
    tier,
    capabilities: {
      captureOrder,
      toolCorrelation: evidence.capabilities.toolCorrelation,
      coldReplay,
      nativeResume,
    },
    loweredReason: loweredReasonFor(floor, invalid, forced) ?? evidence.loweredReason,
  };
}

function weakestOf(
  left: AssistantReplayEvidence["capabilities"]["captureOrder"],
  right: AssistantReplayEvidence["capabilities"]["captureOrder"],
): AssistantReplayEvidence["capabilities"]["captureOrder"] {
  const rank = { text_only: 0, segment: 1, exact: 2 } as const;
  return rank[left] <= rank[right] ? left : right;
}

function loweredReasonFor(
  floor: ProviderItemPlacement["kind"],
  invalid: boolean,
  forced: boolean,
): string | undefined {
  if (invalid) return "capture_invalid_declaration_present";
  if (forced) return "forced_quiescence";
  if (floor === "unplaced") return "unplaced_provider_item_present";
  if (floor === "segment") return "segment_placed_provider_item_present";
  return undefined;
}

/**
 * The conservative version-1 to version-2 placement. A persisted segment with an
 * exact provider-message ID supports a `segment` claim and nothing more;
 * anything else is `unplaced`. Migration never invents a provider block index.
 */
export function migratedPlacement(
  providerMessageId: string | undefined,
): ProviderItemPlacement {
  return providerMessageId === undefined || providerMessageId.trim().length === 0
    ? { kind: "unplaced" }
    : { kind: "segment", providerMessageKey: providerMessageId };
}

/** The capture evidence a migrated version-1 item carries in memory. */
export function migratedCaptureEvidence(
  turnId: string,
  providerMessageId: string | undefined,
): ProviderItemCaptureEvidence {
  return {
    originBatchId: `migrated:${turnId}`,
    placement: migratedPlacement(providerMessageId),
    validity: "valid",
  };
}

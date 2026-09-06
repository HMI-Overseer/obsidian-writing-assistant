import type { AssistantTurnRecord, AssistantTurnStatus } from "../../shared/types";
import type { AssistantTurnBuilder, AssistantTurnSnapshot } from "./AssistantTurnBuilder";
import {
  validateAssistantTurn,
  type AssistantTurnInvalidReason,
} from "./assistantTurnValidation";

type TerminalAssistantTurnStatus = Exclude<AssistantTurnStatus, "streaming">;

export interface AssistantTurnSalvage {
  turn: AssistantTurnRecord;
  /** What validation refused, in the order it was cut away. Empty when nothing was. */
  dropped: AssistantTurnInvalidReason[];
  /** The builder's own failure, when `finishTurn()` threw and the record was salvaged. */
  finishError?: unknown;
}

/**
 * Finish the turn, and when the builder refuses, keep what it can.
 *
 * A finished record fails validation only through a plugin defect: every writer
 * is typed, so an invalid field is a bug in the writer, not bad input. The cost
 * of that bug must stay with the field it touched. Persisting an empty record in
 * its place erased whole turns of prose and every timeline step over one
 * oversized detail line (ADR-0040).
 */
export function finishOrSalvageAssistantTurn(
  builder: AssistantTurnBuilder,
  status: TerminalAssistantTurnStatus,
): AssistantTurnSalvage {
  try {
    return { turn: builder.finishTurn(status), dropped: [] };
  } catch (error) {
    return { ...salvageAssistantTurn(builder.snapshot(), status), finishError: error };
  }
}

/**
 * The largest valid record inside a snapshot: each pass validates, then cuts
 * away exactly what the failure names, an item, a segment with the items that
 * lost their segment, or an optional top-level field. A failure that names
 * none of those (the turn's own identity, say) leaves nothing to keep, and the
 * record falls back to an empty turn under the same identity.
 */
export function salvageAssistantTurn(
  snapshot: AssistantTurnSnapshot,
  status: TerminalAssistantTurnStatus,
): AssistantTurnSalvage {
  const candidate: AssistantTurnSnapshot = { ...structuredClone(snapshot), status };
  const dropped: AssistantTurnInvalidReason[] = [];
  // Every pass removes something, so the passes are bounded by what there is to remove.
  const passes = snapshot.segments.length + snapshot.items.length + 2;
  for (let pass = 0; pass <= passes; pass += 1) {
    const result = validateAssistantTurn(candidate);
    if (result.ok) return { turn: result.value, dropped };
    dropped.push(result.reason);
    if (!cutAway(candidate, result.reason.path)) break;
  }
  return {
    turn: {
      schemaVersion: snapshot.schemaVersion,
      id: snapshot.id,
      status,
      segments: [],
      items: [],
    },
    dropped,
  };
}

function cutAway(candidate: AssistantTurnSnapshot, path: string): boolean {
  const item = /^items\[(\d+)\]/.exec(path);
  if (item) {
    candidate.items.splice(Number(item[1]), 1);
    return true;
  }
  const segment = /^segments\[(\d+)\]/.exec(path);
  if (segment) {
    candidate.segments.splice(Number(segment[1]), 1);
    const remaining = new Set(candidate.segments.map((entry) => entry.id));
    candidate.items = candidate.items.filter((entry) => remaining.has(entry.segmentId));
    return true;
  }
  if (path.startsWith("captureDiagnostics")) {
    delete candidate.captureDiagnostics;
    return true;
  }
  if (path.startsWith("quiescence")) {
    delete candidate.quiescence;
    return true;
  }
  return false;
}

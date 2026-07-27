import { GENERATION_AUDIT_SUMMARY_CHARS } from "../constants";
import type {
  EffectBoundary,
  EffectBoundaryGuard,
  EffectIntentRequest,
  EffectRunOwnership,
  GenerationAuditIdentity,
  GenerationAuditRecorder,
  ProviderCaptureDiagnostic,
  ProviderOption,
  ToolActionCorrelationEvidence,
  ToolActionFamily,
} from "./types";

/**
 * Write-ahead effect boundaries (RFC-0011 phase 6, plan section 9.1).
 *
 * A callback cannot be trusted to report evidence after an irreversible effect,
 * so the boundary is: state the intent, wait for that statement to be durable,
 * then act. Everything about that ordering lives in
 * {@link crossWithDurableIntent} rather than in each executor, because the order
 * is the whole guarantee.
 *
 * The concept is provider-neutral. Claude Code's generation lease implements
 * {@link EffectBoundaryGuard} with its own liveness (lease state plus the
 * generation signal); the plugin's own tool loop uses
 * {@link createDirectEffectGuard}, whose liveness is the turn signal alone. Both
 * write to the same conversation-scoped audit.
 */

/**
 * Deterministic intent identity, so appending the same intent twice is a no-op
 * rather than a second record of one action. `(actionRef, targetId)` is exactly
 * the pair the action ledger allows one `intent_recorded` event for.
 */
export function intentIdFor(actionRef: string, targetId: string): string {
  return `intent-${actionRef}-${targetId}`;
}

/**
 * Clamp for text this plugin authors about an action, applied where it is
 * written (settled decision 23). Nothing is ever refused on read for its length:
 * a read-time gate would turn our own formatting preference into a reason to
 * refuse the user's saved evidence.
 */
export function boundedAuditText(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= GENERATION_AUDIT_SUMMARY_CHARS
    ? collapsed
    : `${collapsed.slice(0, GENERATION_AUDIT_SUMMARY_CHARS - 1)}…`;
}

/**
 * The action family a boundary belongs to. One mapping, so the family on an audit
 * record can never disagree with the boundary that wrote it.
 */
export function effectFamilyFor(boundary: EffectBoundary): ToolActionFamily {
  switch (boundary) {
    case "edit_review":
      return "edit";
    case "vault_op_review":
      return "vault_op";
    case "memory_review":
      return "memory";
    case "ask_interaction":
      return "interaction";
  }
}

/** The bounded intent one tool call states before it crosses `boundary`. */
export function effectIntentFor(
  boundary: EffectBoundary,
  call: { id: string; name: string; arguments: Record<string, unknown> },
  correlation: ToolActionCorrelationEvidence,
): EffectIntentRequest {
  return {
    boundary,
    family: effectFamilyFor(boundary),
    correlation,
    ...describeEffectTarget(call),
  };
}

/** What one liveness policy has to answer for the ordering below. */
export interface EffectBoundaryDeps {
  /**
   * Synchronous liveness. Consulted before the intent is written, so a run that
   * is already stopping costs no store round trip, and again after the write, so
   * a Stop that lands *during* it still refuses.
   */
  isLive: () => boolean;
  audit: GenerationAuditRecorder | null;
  ownership: () => EffectRunOwnership;
  /** Called once, after the crossing is committed. */
  onCrossed?: (boundary: EffectBoundary) => void;
}

/**
 * Check, persist, re-check, cross.
 *
 * The re-check is not tidiness. Before phase 6 the path from callback admission
 * through the boundary to the review's own registration ran in one synchronous
 * block, so a Stop could not land inside it. Awaiting the intent persist opens
 * that window for the first time, and a Stop landing in it would otherwise
 * register a review after the pending ones were already cancelled, which the
 * deadline-free in-flight drain would then wait on forever. A refusal at the
 * re-check reconciles the intent immediately: nothing happened, and recording
 * that as an unknown outcome would overstate what we do not know.
 */
export async function crossWithDurableIntent(
  boundary: EffectBoundary,
  intent: EffectIntentRequest,
  deps: EffectBoundaryDeps,
): Promise<boolean> {
  if (!deps.isLive()) return false;
  if (deps.audit) {
    try {
      await deps.audit.recordIntent(intent, deps.ownership());
    } catch {
      // The effect cannot be recorded, so the effect does not happen. This is
      // the same refusal cancellation already uses, so no executor needs a new
      // branch for it.
      return false;
    }
    if (!deps.isLive()) {
      await deps.audit.reconcileIntent(intent);
      return false;
    }
  }
  deps.onCrossed?.(boundary);
  return true;
}

/**
 * The plugin tool loop's boundary. Its liveness is the turn signal: the loop
 * awaits its effects inline, so there is no separate owner that can vanish
 * underneath one, and a cancelled turn is the only reason to refuse.
 *
 * It deliberately does not report to {@link ../chat/streaming/TurnRunOwner}'s
 * consequential-callback flag. That flag refuses a retry of a request whose
 * in-flight callbacks may already have acted; a plugin-loop effect runs between
 * rounds, never during a retryable attempt, so reporting it would only suppress
 * legitimate retries for the rest of the turn.
 */
export function createDirectEffectGuard(deps: {
  signal?: AbortSignal;
  audit: GenerationAuditRecorder | null;
  ownership: () => EffectRunOwnership;
}): EffectBoundaryGuard {
  return {
    crossEffectBoundary: (boundary, intent) =>
      crossWithDurableIntent(boundary, intent, {
        isLive: () => !deps.signal?.aborted,
        audit: deps.audit,
        ownership: deps.ownership,
      }),
  };
}

/** Tool-argument keys that name the thing an action happens to. */
const TARGET_ARG_KEYS = ["path", "from", "to", "name", "title"] as const;

/**
 * The bounded target identity and summary an intent carries.
 *
 * Paths and names only: they are the target identity section 4.2 asks for, and
 * they are already visible on the timeline row. Content, diffs, and results are
 * never read here. When a call names nothing, the tool call itself is the target,
 * which is honest rather than a guess.
 */
export function describeEffectTarget(call: {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}): { targetId: string; summary: string } {
  const named = TARGET_ARG_KEYS.map((key) => call.arguments[key]).find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const targetId = boundedAuditText(named ?? call.id);
  return { targetId, summary: boundedAuditText(`${call.name} ${targetId}`) };
}

/** Correlation evidence for a tool call the plugin's own loop is executing. */
export function directCorrelationFor(
  toolCallId: string,
): ToolActionCorrelationEvidence {
  return toolCallId.startsWith("lmsa-tool-")
    ? { kind: "plugin_id", toolCallId }
    : { kind: "provider_id", toolCallId };
}

/**
 * The terminal evidence for an intent whose action never reached its review.
 *
 * Section 9.2 asks for such an intent to be persisted as an unplaced
 * `outcome_unknown` ledger event, and against the tree that is impossible: every
 * `ToolActionLedgerEntry` payload requires evidence the intent deliberately does
 * not carry (a document snapshot and resolved edit, a real `VaultOperation`, a
 * `Memory`, an interaction's question set), and section 4.2 forbids duplicating
 * exactly those. Synthesizing one would mean inventing the record. So the
 * evidence lands as one bounded diagnostic on the terminal turn instead, which is
 * a surface the renderer already projects (settled decision 27), while intents
 * whose action did reach its review keep the real ledger events.
 */
export function unknownOutcomeDiagnostic(
  provider: ProviderOption,
  intent: { family: string; summary: string; correlation: ToolActionCorrelationEvidence },
): ProviderCaptureDiagnostic {
  const correlation =
    intent.correlation.kind === "none"
      ? intent.correlation.transport
      : intent.correlation.toolCallId;
  return {
    code: "consequential_outcome_unknown",
    provider,
    stage: "callback",
    message: boundedAuditText(
      `${intent.family} ${intent.summary} (${correlation}) was authorized and its outcome is unknown`,
    ),
  };
}

/** Re-exported so an executor imports one module for the whole boundary. */
export type {
  EffectBoundary,
  EffectBoundaryGuard,
  EffectIntentRequest,
  EffectRunOwnership,
  GenerationAuditIdentity,
  GenerationAuditRecorder,
};

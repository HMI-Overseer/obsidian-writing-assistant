import { boundedAuditText } from "../../shared/generationAudit";
import type {
  AssistantTurnRevision,
  ConversationMessage,
  GenerationAuditIntent,
  InFlightGenerationAudit,
  ProviderCaptureDiagnostic,
} from "../../shared/types";
import { syncAssistantCompatibilityProjection } from "./assistantRevisions";

/**
 * Fail-closed recovery of an orphaned in-flight generation audit (ADR-0033).
 *
 * An audit on disk means the generation that owned it never reached its terminal
 * transaction. What is knowable is exactly what the audit says: some consequential
 * actions were authorized, and for each one either the outcome was never reported
 * or it was observed and its record did not survive. The recovery states that and
 * nothing more. It never resumes the provider, never invents prose, and never
 * fabricates a ledger entry, because an entry needs a family payload and an intent
 * deliberately carries none.
 */

/** The failed revision an orphan becomes, with one diagnostic per intent. */
export function buildOrphanRecoveryMessage(
  audit: InFlightGenerationAudit,
): ConversationMessage {
  const revision: AssistantTurnRevision = {
    revisionId: `revision-${audit.turnId}-recovered`,
    kind: "turn",
    origin: "generated",
    createdAt: audit.openedAt,
    provider: audit.provider,
    modelId: audit.modelId,
    turn: {
      schemaVersion: 2,
      id: audit.turnId,
      status: "failed",
      segments: [],
      // No capture survived, and inventing an item would be inventing a
      // provider declaration (ADR-0031).
      items: [],
      // The hard-stop path is the only honest reading of a generation that never
      // settled: forced quiescence forbids native resume and a resume cursor.
      quiescence: "forced",
      captureDiagnostics: audit.intents.map((intent) =>
        orphanedIntentDiagnostic(audit, intent),
      ),
    },
    replayEvidence: {
      tier: "textual",
      capabilities: {
        captureOrder: "text_only",
        toolCorrelation: "none",
        coldReplay: "textual",
        nativeResume: false,
      },
      loweredReason: "orphaned_generation_audit",
    },
    isError: true,
    errorMessage: boundedAuditText(
      `This turn ended without finishing. ${describeIntentCount(audit.intents)} its outcome could not be confirmed.`,
    ),
  };
  return syncAssistantCompatibilityProjection({
    id: audit.messageId,
    role: "assistant",
    content: "",
    revisions: [revision],
    activeRevisionId: revision.revisionId,
    actionLedger: [],
  });
}

/**
 * One bounded record per intent. The code distinguishes the two things that can
 * be true: nobody reported an outcome, or an outcome was observed under a lease
 * whose terminal record never reached disk. Neither may be dropped, and neither
 * may be presented as more certain than it is.
 */
function orphanedIntentDiagnostic(
  audit: InFlightGenerationAudit,
  intent: GenerationAuditIntent,
): ProviderCaptureDiagnostic {
  const correlation =
    intent.correlation.kind === "none"
      ? intent.correlation.transport
      : intent.correlation.toolCallId;
  const observed = intent.outcome === "resolved";
  return {
    code: observed
      ? "consequential_effect_unrecorded"
      : "consequential_outcome_unknown",
    provider: audit.provider,
    stage: "callback",
    message: boundedAuditText(
      observed
        ? `${intent.family} ${intent.summary} (${correlation}) completed under a generation whose record was lost`
        : `${intent.family} ${intent.summary} (${correlation}) was authorized and its outcome is unknown`,
    ),
  };
}

function describeIntentCount(intents: readonly GenerationAuditIntent[]): string {
  return intents.length === 1
    ? "One action had already been authorized, and"
    : `${intents.length} actions had already been authorized, and`;
}

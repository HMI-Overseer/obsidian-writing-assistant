import { createStreamMetadataGate } from "../../src/api/assistantStreamRun";
import type { AssistantStreamRun } from "../../src/api/assistantStreamRun";
import {
  createOwnedStreamRun,
  detachedAttemptContext,
} from "../../src/api/assistantStreamRuntime";
import type {
  AssistantStreamEvent,
  StopReason,
  UsageResult,
} from "../../src/api/usageTypes";
import type {
  AssistantReplayEvidence,
  ProviderReplayCapsule,
} from "../../src/shared/types";

/**
 * Adapts a hand-built stream, the shape `ChatClient.stream()` returned before
 * RFC-0011 phase 2, into an owned {@link AssistantStreamRun}.
 *
 * Test doubles across the suite construct a generator plus four deferred
 * promises. Wrapping them here rather than rewriting each fake keeps those tests
 * about what they were about, while still running them through the real
 * ownership runtime, so a fake cannot pass by exposing a contract the production
 * factory does not implement.
 */
export interface LegacyStreamShape {
  events: AsyncGenerator<AssistantStreamEvent>;
  usage: Promise<UsageResult | null>;
  stopReason: Promise<StopReason>;
  replayCapsule: Promise<ProviderReplayCapsule | null>;
  replayEvidence: Promise<AssistantReplayEvidence>;
}

export function ownedRunFromLegacy(
  legacy: LegacyStreamShape,
  label = "test-attempt",
): AssistantStreamRun<AssistantStreamEvent> {
  const metadata = createStreamMetadataGate();

  // The legacy promises resolve in the inner generator's own `finally`, so they
  // are awaited here after it completes and before the run settles. Settling the
  // gate any later would let the run's `settleRemaining()` win with fallbacks and
  // silently replace the terminal facts a test is asserting on.
  async function* source(): AsyncGenerator<AssistantStreamEvent> {
    try {
      yield* legacy.events;
    } finally {
      metadata.usage.settle(await legacy.usage.catch(() => null));
      metadata.stopReason.settle(await legacy.stopReason.catch(() => "unknown"));
      metadata.replayCapsule.settle(await legacy.replayCapsule.catch(() => null));
      const evidence = await legacy.replayEvidence.catch(() => null);
      if (evidence) metadata.replayEvidence.settle(evidence);
    }
  }

  return createOwnedStreamRun({
    attempt: detachedAttemptContext(label),
    provider: "lmstudio",
    open: source,
    metadata,
  });
}

import { CAPTURE_DIAGNOSTIC_MESSAGE_CHARS } from "../constants";
import type {
  AssistantReplayEvidence,
  ProviderCaptureDiagnostic,
  ProviderQuiescence,
  ProviderReplayCapsule,
} from "../shared/types";
import type { AssistantCaptureBatch } from "./assistantCapture";
import type { StopReason, UsageResult } from "./usageTypes";

/**
 * Explicit provider-run ownership (RFC-0011).
 *
 * A generator that a consumer stops reading is not a stopped provider. This
 * module names the contract that makes stopping explicit: every attempt is
 * constructed under a lease, can be cancelled with a bounded reason, and
 * settles exactly once with an honest account of whether quiescence was proven
 * or forced.
 *
 * Live since phase 2: {@link AssistantStreamRun} is what `ChatClient.stream()`
 * returns, and the old `StreamResult` is gone rather than aliased. Since phase 4
 * it carries {@link AssistantCaptureBatch} rather than individual events.
 */

/**
 * Why an attempt is being stopped. Closed and bounded so that settlement,
 * session reuse, and retry permission can each branch on the real cause. In
 * particular a user Stop is never inferred from an arbitrary `AbortError`.
 */
export type StreamCancelReason =
  /** The user pressed Stop. The only reason that may preserve session reuse. */
  | "user_stop"
  /** Capture identity conflicted; the transcript is no longer authoritative. */
  | "capture_failed"
  /** The event consumer returned before the stream ended. */
  | "consumer_returned"
  /** A reducer, renderer, review, or finalization step threw. */
  | "downstream_failed"
  /** A retryable pre-commit attempt is being abandoned before the next one. */
  | "retry_abandoned"
  /** The plugin is unloading or the conversation is being torn down. */
  | "plugin_unload"
  /** The provider itself failed and the run is being closed out. */
  | "provider_failed";

/** Identity and cancellation authority handed to one provider attempt. */
export interface AssistantStreamAttemptContext {
  /** The pre-minted turn ID, allocated before retry can call a provider. */
  turnId: string;
  /** Monotonic within the turn, starting at 1. */
  attemptOrdinal: number;
  /** `${turnId}#${attemptOrdinal}`, the generation lease identity. */
  leaseId: string;
  /**
   * Owned by the lease, not by the caller's request. A provider combines it with
   * its own transport abort rather than replacing it, so the cancel reason
   * survives.
   */
  signal: AbortSignal;
}

/** Builds the canonical lease ID for an attempt. */
export function leaseIdFor(turnId: string, attemptOrdinal: number): string {
  return `${turnId}#${attemptOrdinal}`;
}

/**
 * The abort reason plugin teardown passes to `AbortController.abort()`.
 *
 * Both a user Stop and a plugin unload reach a generation as a bare abort, but
 * they must not settle the same way: `user_stop` is the only reason that may
 * preserve a Claude session for reuse, and a session the plugin is about to
 * dispose is not one to preserve. Carrying the distinction on the signal itself
 * is what stops it from being guessed downstream.
 */
export const PLUGIN_UNLOAD_ABORT_REASON = "lmsa-plugin-unload";

/** Reads an abort back as its bounded cancel reason. */
export function cancelReasonForAbort(signal: AbortSignal): StreamCancelReason {
  return signal.reason === PLUGIN_UNLOAD_ABORT_REASON ? "plugin_unload" : "user_stop";
}

/** The terminal account of one attempt. Resolves exactly once, on every path. */
export interface AssistantStreamSettlement {
  /**
   * `proven` means the provider is terminal or acknowledged cancellation and
   * every entered callback settled normally. `forced` means the hard-dispose
   * path ran; it is never proof of exact capture or session validity.
   */
  quiescence: ProviderQuiescence;
  /** Null when the attempt ended naturally rather than being cancelled. */
  reason: StreamCancelReason | null;
  /** True when the graceful deadline expired and hard disposal had to run. */
  hardDisposed: boolean;
  /**
   * Bounded terminal evidence. Iterator-return failures are attached here and
   * never replace the original capture error.
   */
  diagnostics: ProviderCaptureDiagnostic[];
}

/**
 * One owned provider attempt.
 *
 * The stream unit is the capture batch, not the individual event (settled
 * decision 1, landed in phase 4). Keeping batches behind an adapter would have
 * preserved the event-by-event publication seam the RFC exists to remove: a
 * transaction needs to know where one frame's facts end, and flattening erases
 * that boundary at the stream seam where no consumer can honestly recover it.
 */
export interface AssistantStreamRun {
  events: AsyncIterable<AssistantCaptureBatch>;
  /** Idempotent. Safe before the first event, after commitment, and after settlement. */
  cancel(reason: StreamCancelReason): Promise<void>;
  /** Resolves on success, stop, failure, construction failure, zero events, and forced disposal. */
  settled: Promise<AssistantStreamSettlement>;
  usage: Promise<UsageResult | null>;
  stopReason: Promise<StopReason>;
  replayCapsule: Promise<ProviderReplayCapsule | null>;
  replayEvidence: Promise<AssistantReplayEvidence>;
}

/**
 * The two-deadline termination contract every provider must supply.
 *
 * Cancel and wait for the graceful deadline. When it expires, invoke
 * {@link hardDispose} unconditionally and wait for its shorter deadline. A
 * provider with no verifiable hard-dispose operation cannot ship under RFC-0011,
 * which is why this is a required member rather than an optional hook.
 */
export interface ProviderDisposalHooks {
  /** Ask the provider to stop and settle by itself. */
  requestGracefulStop(reason: StreamCancelReason): Promise<void>;
  /**
   * Mandatory and bounded. Resolves once the provider can issue no further work.
   * Rejects when disposal itself could not be proven, which forces settlement.
   */
  hardDispose(): Promise<void>;
  gracefulDeadlineMs: number;
  hardDisposeDeadlineMs: number;
}

/**
 * A promise that resolves exactly once, with a bounded fallback for the paths
 * where a provider supplies no value. Later resolutions are ignored rather than
 * throwing, so a settlement race cannot itself become the failure.
 */
export interface SettleOnce<T> {
  promise: Promise<T>;
  /** Returns true when this call was the one that resolved the promise. */
  settle(value: T): boolean;
  /** Resolves with the fallback if nothing has settled yet. */
  settleWithFallback(): boolean;
  readonly isSettled: boolean;
}

export function createSettleOnce<T>(fallback: T): SettleOnce<T> {
  let resolveValue!: (value: T) => void;
  let settled = false;
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  const settle = (value: T): boolean => {
    if (settled) return false;
    settled = true;
    resolveValue(value);
    return true;
  };
  return {
    promise,
    settle,
    settleWithFallback: () => settle(fallback),
    get isSettled() {
      return settled;
    },
  };
}

/**
 * The four metadata promises every attempt must resolve, with the bounded
 * fallbacks used when a provider supplied none. Grouped so no implementation can
 * forget one on a failure path.
 */
export interface StreamMetadataGate {
  usage: SettleOnce<UsageResult | null>;
  stopReason: SettleOnce<StopReason>;
  replayCapsule: SettleOnce<ProviderReplayCapsule | null>;
  replayEvidence: SettleOnce<AssistantReplayEvidence>;
  /** Resolves anything still outstanding with its fallback. Idempotent. */
  settleRemaining(): void;
}

export function createStreamMetadataGate(
  fallbackEvidence: AssistantReplayEvidence = failedAttemptEvidence(),
): StreamMetadataGate {
  const usage = createSettleOnce<UsageResult | null>(null);
  const stopReason = createSettleOnce<StopReason>("unknown");
  const replayCapsule = createSettleOnce<ProviderReplayCapsule | null>(null);
  const replayEvidence = createSettleOnce<AssistantReplayEvidence>(fallbackEvidence);
  return {
    usage,
    stopReason,
    replayCapsule,
    replayEvidence,
    settleRemaining: () => {
      usage.settleWithFallback();
      stopReason.settleWithFallback();
      replayCapsule.settleWithFallback();
      replayEvidence.settleWithFallback();
    },
  };
}

/** The evidence an attempt that never produced usable capture must report. */
export function failedAttemptEvidence(
  loweredReason = "stream_attempt_failed_before_commit",
): AssistantReplayEvidence {
  return {
    tier: "textual",
    capabilities: {
      captureOrder: "text_only",
      toolCorrelation: "none",
      coldReplay: "textual",
      nativeResume: false,
    },
    loweredReason,
  };
}

/**
 * Returns the async iterator an owner acquired, swallowing a return failure into
 * a diagnostic rather than letting it replace the original error. Every function
 * that calls `[Symbol.asyncIterator]()` manually must route its cleanup here.
 */
export async function closeIterator(
  iterator: { return?: (value?: unknown) => unknown } | null,
  onDiagnostic?: (diagnostic: ProviderCaptureDiagnostic) => void,
): Promise<void> {
  if (!iterator?.return) return;
  try {
    await iterator.return(undefined);
  } catch (error) {
    onDiagnostic?.({
      code: "iterator_return_failed",
      provider: "unknown",
      stage: "settlement",
      message: boundedFailureMessage(error),
    });
  }
}

/**
 * A payload-free description of a thrown value, clamped where it is authored.
 *
 * The clamp is the whole no-raw-payload rule in one place: a diagnostic names an
 * invariant, so anything long enough to be cut here was carrying something it
 * should not. Reading a diagnostic never rejects one for its length.
 */
export function boundedFailureMessage(error: unknown): string {
  const text =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.length <= CAPTURE_DIAGNOSTIC_MESSAGE_CHARS
    ? text
    : `${text.slice(0, CAPTURE_DIAGNOSTIC_MESSAGE_CHARS - 1)}…`;
}

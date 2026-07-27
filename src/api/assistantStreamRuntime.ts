import type {
  ProviderCaptureDiagnostic,
  ProviderOption,
  ProviderQuiescence,
} from "../shared/types";
import type {
  AssistantStreamAttemptContext,
  AssistantStreamRun,
  AssistantStreamSettlement,
  ProviderDisposalHooks,
  StreamCancelReason,
  StreamMetadataGate,
} from "./assistantStreamRun";
import {
  boundedFailureMessage,
  closeIterator,
  createSettleOnce,
} from "./assistantStreamRun";

/**
 * The one implementation of {@link AssistantStreamRun} every provider uses (RFC-0011
 * phase 2).
 *
 * Phase 0 measured that a generator a consumer stops reading is not a stopped
 * provider, so ownership cannot be left to each client to remember. This factory
 * owns the parts that were previously forgotten in four separate places: it
 * retains the raw iterator outside the consumption loop and returns it on every
 * exit but natural exhaustion, it resolves the metadata gate on every path, it
 * makes `cancel()` idempotent, and it runs the two-deadline disposal ladder so a
 * provider that will not stop gracefully is hard-disposed rather than awaited
 * forever.
 */

/** Everything one owned attempt needs to run and to stop. */
export interface OwnedStreamRunConfig<Event> {
  /** Identity and cancellation authority, allocated by the turn-run owner. */
  attempt: AssistantStreamAttemptContext;
  /** Provider key, recorded on diagnostics so a settlement names its source. */
  provider: ProviderOption | "unknown";
  /**
   * Opens the underlying source. Called once, lazily, on first iteration, so an
   * attempt that is constructed and then abandoned never starts a provider.
   */
  open: () => AsyncIterable<Event>;
  /** Resolved on every exit path, including construction failure and zero events. */
  metadata: StreamMetadataGate;
  /**
   * The immediate local stop: abort the transport controller this attempt owns.
   * Called before the disposal ladder and safe to call more than once. It must
   * not replace the lease signal, only combine with it, so the cancel reason
   * survives.
   */
  abort?: (reason: StreamCancelReason) => void;
  /**
   * Two-deadline termination for a provider that owns an OS process and can
   * therefore outlive its iterator. Absent for direct HTTP transports, whose stop
   * is {@link abort} plus iterator closure, both local operations that never wait
   * on the remote.
   */
  disposal?: ProviderDisposalHooks;
}

/** Result of racing one termination step against its measured deadline. */
interface DeadlineOutcome {
  ok: boolean;
  timedOut: boolean;
  error: unknown;
}

/**
 * Races one termination step against its deadline. A step that rejects and a step
 * that overruns are different failures and are reported as such, because only the
 * second one means the provider stopped answering.
 */
async function settleWithin(
  step: () => Promise<void>,
  deadlineMs: number,
): Promise<DeadlineOutcome> {
  let timer: number | null = null;
  const expiry = new Promise<"expired">((resolve) => {
    timer = window.setTimeout(() => resolve("expired"), deadlineMs);
  });
  try {
    const outcome = await Promise.race([
      step().then(() => "done" as const, (error: unknown) => ({ error })),
      expiry,
    ]);
    if (outcome === "expired") return { ok: false, timedOut: true, error: null };
    if (outcome === "done") return { ok: true, timedOut: false, error: null };
    return { ok: false, timedOut: false, error: outcome.error };
  } finally {
    if (timer !== null) window.clearTimeout(timer);
  }
}

export function createOwnedStreamRun<Event>(
  config: OwnedStreamRunConfig<Event>,
): AssistantStreamRun<Event> {
  const diagnostics: ProviderCaptureDiagnostic[] = [];
  const settlement = createSettleOnce<AssistantStreamSettlement>({
    quiescence: "forced",
    reason: null,
    hardDisposed: false,
    diagnostics: [],
  });

  let iterator: AsyncIterator<Event> | null = null;
  let stopping: Promise<void> | null = null;
  let reason: StreamCancelReason | null = null;

  const note = (code: string, error: unknown): void => {
    diagnostics.push({
      code,
      provider: config.provider,
      stage: "settlement",
      message: boundedFailureMessage(error),
    });
  };

  const finish = (quiescence: ProviderQuiescence, hardDisposed: boolean): void => {
    config.metadata.settleRemaining();
    settlement.settle({
      quiescence,
      reason,
      hardDisposed,
      diagnostics: [...diagnostics],
    });
  };

  const returnSource = async (): Promise<void> => {
    await closeIterator(iterator, (diagnostic) => {
      diagnostics.push({ ...diagnostic, provider: config.provider });
    });
  };

  /**
   * The single stop path.
   *
   * The graceful tier is "deliver the cancel, return the iterator, and let the
   * provider unwind within its own measured deadline". Returning the iterator is
   * part of the graceful step rather than something that follows it, because
   * unwinding is what runs the provider's own termination: the persistent
   * session's clean `interrupt()` bookkeeping, the legacy subprocess's `kill()`,
   * the SDK query's transport close. Overrunning that deadline is the one failure
   * a timeout may name, and it escalates to mandatory hard disposal.
   *
   * A provider with no disposal hooks has no process that can outlive its
   * iterator, so abort plus return is its whole stop and there is nothing for a
   * deadline to guard.
   */
  const stop = async (next: StreamCancelReason): Promise<void> => {
    if (settlement.isSettled) return;
    if (stopping) {
      await stopping;
      return;
    }
    reason = next;
    stopping = (async () => {
      try {
        config.abort?.(next);
      } catch (error) {
        note("transport_abort_failed", error);
      }

      const disposal = config.disposal;
      if (!disposal) {
        await returnSource();
        finish("proven", false);
        return;
      }

      const graceful = await settleWithin(async () => {
        await disposal.requestGracefulStop(next);
        await returnSource();
      }, disposal.gracefulDeadlineMs);
      if (graceful.ok) {
        finish("proven", false);
        return;
      }

      note(
        graceful.timedOut ? "graceful_stop_deadline_expired" : "graceful_stop_refused",
        graceful.timedOut
          ? `provider did not settle within ${disposal.gracefulDeadlineMs}ms`
          : graceful.error,
      );
      const hard = await settleWithin(
        () => disposal.hardDispose(),
        disposal.hardDisposeDeadlineMs,
      );
      if (!hard.ok) {
        note(
          hard.timedOut ? "hard_dispose_deadline_expired" : "hard_dispose_failed",
          hard.timedOut
            ? `no exit proof within ${disposal.hardDisposeDeadlineMs}ms`
            : hard.error,
        );
      }
      // The provider is gone, so returning the iterator now is bookkeeping, but it
      // is still bounded: a generator that will not unwind against a dead process
      // must not become a new place to hang.
      await settleWithin(returnSource, disposal.hardDisposeDeadlineMs);
      finish("forced", true);
    })();
    await stopping;
  };

  async function* events(): AsyncGenerator<Event> {
    // "exhausted" is the only outcome that needs no cleanup: the source is already
    // terminal, so there is nothing to return and nothing left to dispose.
    let outcome: "running" | "exhausted" | "failed" = "running";
    try {
      const source = config.open();
      iterator = source[Symbol.asyncIterator]();
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        yield next.value;
      }
      outcome = "exhausted";
    } catch (error) {
      outcome = "failed";
      note("provider_stream_failed", error);
      throw error;
    } finally {
      if (outcome === "exhausted") {
        finish("proven", false);
      } else {
        // A source that threw is over; a consumer that walked away is not, and
        // the provider behind it is still running. Both settle, only the reason
        // differs, and the reason is what decides session reuse downstream.
        await stop(outcome === "failed" ? "provider_failed" : "consumer_returned");
      }
    }
  }

  return {
    events: events(),
    cancel: stop,
    settled: settlement.promise,
    usage: config.metadata.usage.promise,
    stopReason: config.metadata.stopReason.promise,
    replayCapsule: config.metadata.replayCapsule.promise,
    replayEvidence: config.metadata.replayEvidence.promise,
  };
}

/**
 * A transport-scoped abort controller that also fires when the attempt's lease
 * signal does.
 *
 * A provider must not hand its transport the lease signal directly, because then
 * it has no way to stop only its own attempt, and it must not replace the lease
 * signal either, because the cancel reason lives on the lease. Linking gives it a
 * signal it owns that the lease can still reach.
 */
export function createLinkedAbort(attempt: AssistantStreamAttemptContext): {
  signal: AbortSignal;
  abort: () => void;
  release: () => void;
} {
  const controller = new AbortController();
  const onLeaseAbort = (): void => controller.abort();
  if (attempt.signal.aborted) {
    controller.abort();
  } else {
    attempt.signal.addEventListener("abort", onLeaseAbort, { once: true });
  }
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    release: () => attempt.signal.removeEventListener("abort", onLeaseAbort),
  };
}

/**
 * A standalone attempt context for a caller outside the chat turn pipeline, such
 * as a benchmark or a probe.
 *
 * Real generations get their context from the turn-run owner, which is what makes
 * the lease identity meaningful. This exists so those other callers still get an
 * owned run rather than a second, unowned code path.
 */
export function detachedAttemptContext(
  label: string,
  signal?: AbortSignal,
): AssistantStreamAttemptContext {
  return {
    turnId: label,
    attemptOrdinal: 1,
    leaseId: `${label}#1`,
    signal: signal ?? new AbortController().signal,
  };
}

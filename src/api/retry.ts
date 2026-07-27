import type { TurnRunOwner } from "../chat/streaming/TurnRunOwner";
import type {
  AssistantStreamAttemptContext,
  AssistantStreamRun,
  AssistantStreamSettlement,
} from "./assistantStreamRun";
import {
  closeIterator,
  createSettleOnce,
  createStreamMetadataGate,
} from "./assistantStreamRun";
import type { AssistantCaptureBatch } from "./assistantCapture";

export interface RetryOptions {
  /** Maximum number of attempts (including the initial one). Default: 3. */
  maxAttempts?: number;
  /** Initial delay between retries in ms. Default: 500. */
  initialDelayMs?: number;
  /** Maximum delay between retries in ms. Default: 5000. */
  maxDelayMs?: number;
  /** Abort signal to cancel retries early. */
  signal?: AbortSignal;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 5000;

/**
 * Determines if an error is retryable.
 *
 * Retryable: network errors, HTTP 429 (rate limit), HTTP 5xx (server errors).
 * Not retryable: 4xx client errors (except 429), AbortError, parse errors.
 */
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  // Never retry user-initiated abort
  if (error.name === "AbortError") return false;

  const message = error.message;

  // HTTP status code in error message (pattern: "HTTP <code>")
  const httpMatch = message.match(/HTTP (\d+)/);
  if (httpMatch) {
    const status = parseInt(httpMatch[1], 10);
    // Retry 429 (rate limit) and 5xx (server errors)
    if (status === 429) return true;
    if (status >= 500) return true;
    // Don't retry other 4xx errors
    return false;
  }

  // Transient mid-connection faults are worth retrying. ECONNREFUSED is deliberately
  // excluded: it means nothing is listening on the port (LM Studio not running or a
  // wrong base URL), a definitive negative rather than a transient blip. Retrying it
  // just burns the exponential backoff on a liveness check that will keep failing,
  // which is exactly what made the pre-send "checking model status" gate feel slow.
  if ("code" in error) {
    const code = (error as { code?: string }).code;
    if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EPIPE") {
      return true;
    }
  }

  // Generic network errors
  if (message.includes("fetch failed") || message.includes("network")) {
    return true;
  }

  return false;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
      return;
    }

    const timer = window.setTimeout(resolve, ms);

    signal?.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
    }, { once: true });
  });
}

/**
 * Wraps an async function with retry logic using exponential backoff.
 * Only retries on network errors, HTTP 429, and HTTP 5xx.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const initialDelayMs = options?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const maxDelayMs = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const signal = options?.signal;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry on the last attempt or non-retryable errors
      if (attempt === maxAttempts || !isRetryable(error)) {
        throw error;
      }

      // Exponential backoff: initialDelay * 2^(attempt-1), capped at maxDelay
      const delayMs = Math.min(initialDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      await delay(delayMs, signal);
    }
  }

  // Should be unreachable, but satisfy TypeScript
  throw lastError;
}

/**
 * Retry-on-first-error wrapper for a streaming request. The chat send path streams
 * via {@link ../chat/actions/toolLoop.runToolLoop} → `ChatClient.stream`; unlike
 * {@link withRetry} on the non-streaming `complete()`, a transient 429 / 5xx (incl.
 * Anthropic 529 "overloaded") on a stream surfaces as the delta generator throwing
 * before it yields its first token. This re-issues the whole stream while nothing
 * has been yielded yet (the only safe retry point: once deltas reach the bubble we
 * are committed to that attempt), reusing {@link isRetryable} and the same backoff
 * as `withRetry`, then forwards the committed attempt's usage / toolCalls /
 * stopReason. A retryable failure AFTER the first delta, or any non-retryable
 * failure (incl. AbortError), propagates unchanged.
 *
 * Ownership (ADR-0032). The factory receives an attempt context that
 * the turn-run owner allocates *before* it is invoked, so there is no instant at
 * which a provider is running and unowned, and a factory that throws still has a
 * lease to settle. Three further rules the old wrapper had no way to honor:
 *
 * - an abandoned attempt is cancelled and proven quiet before the next one starts,
 *   rather than left running while the backoff sleeps;
 * - the committed attempt is transferred to the turn-run owner, and this
 *   generator's `finally` cancels it through that owner when its own consumer
 *   returns early, instead of walking away from a live provider;
 * - a retry is refused outright once a consequential callback has entered, because
 *   re-issuing the request could repeat irreversible work the first attempt
 *   already did. That is lease evidence, not "did the UI see a delta".
 */
export function streamWithRetry(
  makeStream: (attempt: AssistantStreamAttemptContext) => AssistantStreamRun,
  owner: TurnRunOwner,
  options?: RetryOptions,
): AssistantStreamRun {
  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const initialDelayMs = options?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const maxDelayMs = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const signal = options?.signal;

  // Deferred fields are forwarded only from the committed attempt. Rejected
  // attempts keep their translator state private and never reach the turn builder.
  const metadata = createStreamMetadataGate();
  const settlement = createSettleOnce<AssistantStreamSettlement>({
    quiescence: "proven",
    reason: "retry_abandoned",
    hardDisposed: false,
    diagnostics: [],
  });

  const forward = (chosen: AssistantStreamRun): void => {
    void chosen.usage.then(
      (value) => metadata.usage.settle(value),
      () => metadata.usage.settleWithFallback(),
    );
    void chosen.stopReason.then(
      (value) => metadata.stopReason.settle(value),
      () => metadata.stopReason.settleWithFallback(),
    );
    void chosen.replayCapsule.then(
      (value) => metadata.replayCapsule.settle(value),
      () => metadata.replayCapsule.settleWithFallback(),
    );
    void chosen.replayEvidence.then(
      (value) => metadata.replayEvidence.settle(value),
      () => metadata.replayEvidence.settleWithFallback(),
    );
    void chosen.settled.then(
      (value) => settlement.settle(value),
      () => settlement.settleWithFallback(),
    );
  };

  async function* events(): AsyncGenerator<AssistantCaptureBatch> {
    let lastError: unknown;
    let committed = false;
    let drained = false;
    // Retained outside the attempt loop so the `finally` can return the iterator
    // this wrapper acquired by hand (ADR-0032).
    let activeIterator: AsyncIterator<AssistantCaptureBatch> | null = null;
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // The lease exists before the factory runs, so construction failure is an
        // owned failure rather than an orphan.
        const lease = owner.openAttempt();
        let run: AssistantStreamRun;
        try {
          run = makeStream(lease.context);
        } catch (error) {
          lease.failConstruction(error);
          lastError = error;
          if (attempt === maxAttempts || !isRetryable(error)) throw error;
          if (owner.retryRefusal()) throw error;
          const delayMs = Math.min(initialDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
          await delay(delayMs, signal);
          continue;
        }
        lease.attach(run);

        const iterator = run.events[Symbol.asyncIterator]();
        activeIterator = iterator;
        let first: IteratorResult<AssistantCaptureBatch>;
        try {
          first = await iterator.next();
        } catch (error) {
          lastError = error;
          // Close this attempt's iterator and prove the provider stopped before
          // the next one opens. Previously the failed attempt was simply dropped.
          await closeIterator(iterator);
          activeIterator = null;
          await lease.cancel("retry_abandoned");
          if (attempt === maxAttempts || !isRetryable(error)) throw error;
          if (owner.retryRefusal()) throw error;
          const delayMs = Math.min(initialDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
          await delay(delayMs, signal);
          continue;
        }

        // Committed to this attempt: transfer it to the turn-run owner, forward its
        // deferred fields, then drain it.
        owner.commitAttempt(lease);
        committed = true;
        forward(run);
        if (!first.done) {
          yield first.value;
          for (;;) {
            const next = await iterator.next();
            if (next.done) break;
            yield next.value;
          }
        }
        drained = true;
        return;
      }
      throw lastError;
    } catch (error) {
      metadata.settleRemaining();
      settlement.settleWithFallback();
      throw error;
    } finally {
      // After commitment this wrapper is an iterator-cleanup custodian, not a
      // second owner: it returns the iterator it acquired, and cancellation goes
      // through the finalizer the turn-run owner registered when the attempt was
      // transferred. A fully drained attempt has nothing left to close or cancel.
      if (committed && !drained) {
        await closeIterator(activeIterator);
        await owner.finalizeCommitted("consumer_returned");
      }
      metadata.settleRemaining();
      settlement.settleWithFallback();
    }
  }

  return {
    events: events(),
    cancel: async (reason) => {
      await owner.cancelAll(reason);
      // Cancelling a wrapper nobody ever iterated must still settle it, otherwise
      // an owner that stops before the first read waits forever on a run that
      // never started.
      metadata.settleRemaining();
      settlement.settleWithFallback();
    },
    settled: settlement.promise,
    usage: metadata.usage.promise,
    stopReason: metadata.stopReason.promise,
    replayCapsule: metadata.replayCapsule.promise,
    replayEvidence: metadata.replayEvidence.promise,
  };
}

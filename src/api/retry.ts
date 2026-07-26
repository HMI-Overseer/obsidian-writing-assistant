import type { AssistantReplayEvidence, ProviderReplayCapsule } from "../shared/types";
import type {
  AssistantStreamEvent,
  StopReason,
  StreamResult,
  UsageResult,
} from "./usageTypes";

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
 */
export function streamWithRetry(
  makeStream: () => StreamResult,
  options?: RetryOptions,
): StreamResult {
  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const initialDelayMs = options?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const maxDelayMs = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const signal = options?.signal;

  // Deferred fields are forwarded only from the committed attempt. Rejected
  // attempts keep their translator state private and never reach the turn builder.
  let resolveUsage!: (value: UsageResult | null) => void;
  let resolveStopReason!: (value: StopReason) => void;
  let resolveReplayCapsule!: (value: ProviderReplayCapsule | null) => void;
  let resolveReplayEvidence!: (value: AssistantReplayEvidence) => void;
  const usage = new Promise<UsageResult | null>((r) => { resolveUsage = r; });
  const stopReason = new Promise<StopReason>((r) => { resolveStopReason = r; });
  const replayCapsule = new Promise<ProviderReplayCapsule | null>((r) => {
    resolveReplayCapsule = r;
  });
  const replayEvidence = new Promise<AssistantReplayEvidence>((r) => {
    resolveReplayEvidence = r;
  });

  // A failed attempt's generator resolves its own discarded promises in finally.
  const forward = (chosen: StreamResult): void => {
    void chosen.usage.then(resolveUsage, () => resolveUsage(null));
    void chosen.stopReason.then(resolveStopReason, () => resolveStopReason("unknown"));
    void chosen.replayCapsule.then(
      resolveReplayCapsule,
      () => resolveReplayCapsule(null),
    );
    void chosen.replayEvidence.then(
      resolveReplayEvidence,
      () => resolveReplayEvidence(failedAttemptEvidence()),
    );
  };

  async function* events(): AsyncGenerator<AssistantStreamEvent> {
    let lastError: unknown;
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const result = makeStream();
        const iterator = result.events[Symbol.asyncIterator]();
        let first: IteratorResult<AssistantStreamEvent>;
        try {
          first = await iterator.next();
        } catch (error) {
          lastError = error;
          if (attempt === maxAttempts || !isRetryable(error)) throw error;
          const delayMs = Math.min(initialDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
          await delay(delayMs, signal);
          continue;
        }
        // Committed to this attempt: forward its deferred fields, then drain it.
        forward(result);
        if (!first.done) {
          yield first.value;
          while (true) {
            const next = await iterator.next();
            if (next.done) break;
            yield next.value;
          }
        }
        return;
      }
      throw lastError;
    } catch (error) {
      // Every attempt failed before committing (or the committed stream errored
      // mid-flight). Resolve our promises so awaiters never hang; if a stream was
      // committed these are already resolved via forward() and these are no-ops.
      resolveUsage(null);
      resolveStopReason("unknown");
      resolveReplayCapsule(null);
      resolveReplayEvidence(failedAttemptEvidence());
      throw error;
    }
  }

  return {
    events: events(),
    usage,
    stopReason,
    replayCapsule,
    replayEvidence,
  };
}

function failedAttemptEvidence(): AssistantReplayEvidence {
  return {
    tier: "textual",
    capabilities: {
      captureOrder: "text_only",
      toolCorrelation: "none",
      coldReplay: "textual",
      nativeResume: false,
    },
    loweredReason: "stream_attempt_failed_before_commit",
  };
}

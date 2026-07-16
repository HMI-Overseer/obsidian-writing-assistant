import type { StreamResult, UsageResult, StopReason } from "./usageTypes";
import type { ToolCall } from "../tools/types";

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

  // Network-level errors are retryable (ECONNRESET, ECONNREFUSED, ETIMEDOUT, etc.)
  if ("code" in error) {
    const code = (error as { code?: string }).code;
    if (code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "EPIPE") {
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

  // Deferred fields, forwarded from whichever attempt we commit to. Per the
  // StreamResult contract these resolve only after `deltas` is fully consumed.
  let resolveUsage!: (value: UsageResult | null) => void;
  let resolveToolCalls!: (value: ToolCall[] | null) => void;
  let resolveStopReason!: (value: StopReason) => void;
  let resolveThinkingBlocks!: (value: unknown[] | null) => void;
  const usage = new Promise<UsageResult | null>((r) => { resolveUsage = r; });
  const toolCalls = new Promise<ToolCall[] | null>((r) => { resolveToolCalls = r; });
  const stopReason = new Promise<StopReason>((r) => { resolveStopReason = r; });
  const thinkingBlocks = new Promise<unknown[] | null>((r) => { resolveThinkingBlocks = r; });

  // Forward a committed attempt's deferred fields onto ours. A failed attempt's own
  // generator already resolved its (discarded) promises in its finally; we ignore those.
  const forward = (chosen: StreamResult): void => {
    void chosen.usage.then(resolveUsage, () => resolveUsage(null));
    void chosen.toolCalls.then(resolveToolCalls, () => resolveToolCalls(null));
    void chosen.stopReason.then(resolveStopReason, () => resolveStopReason("unknown"));
    if (chosen.thinkingBlocks) {
      void chosen.thinkingBlocks.then(resolveThinkingBlocks, () => resolveThinkingBlocks(null));
    } else {
      resolveThinkingBlocks(null);
    }
  };

  async function* deltas(): AsyncGenerator<string> {
    let lastError: unknown;
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const result = makeStream();
        const iterator = result.deltas[Symbol.asyncIterator]();
        let first: IteratorResult<string>;
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
      resolveToolCalls(null);
      resolveStopReason("unknown");
      resolveThinkingBlocks(null);
      throw error;
    }
  }

  return { deltas: deltas(), usage, toolCalls, stopReason, thinkingBlocks };
}

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
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }

    const timer = setTimeout(resolve, ms);

    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Aborted"));
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

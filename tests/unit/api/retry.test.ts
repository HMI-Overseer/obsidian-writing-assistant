import { describe, it, expect, vi } from "vitest";
import { isRetryable, withRetry } from "../../../src/api/retry";

describe("isRetryable", () => {
  it("returns false for non-Error values", () => {
    expect(isRetryable("string error")).toBe(false);
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable(42)).toBe(false);
  });

  it("returns false for AbortError", () => {
    const err = new Error("Aborted");
    err.name = "AbortError";
    expect(isRetryable(err)).toBe(false);
  });

  it("returns true for HTTP 429", () => {
    expect(isRetryable(new Error("HTTP 429: Rate limit exceeded"))).toBe(true);
  });

  it("returns true for HTTP 500", () => {
    expect(isRetryable(new Error("HTTP 500: Internal Server Error"))).toBe(true);
  });

  it("returns true for HTTP 502", () => {
    expect(isRetryable(new Error("HTTP 502"))).toBe(true);
  });

  it("returns true for HTTP 503", () => {
    expect(isRetryable(new Error("HTTP 503: Service Unavailable"))).toBe(true);
  });

  it("returns false for HTTP 400", () => {
    expect(isRetryable(new Error("HTTP 400: Bad Request"))).toBe(false);
  });

  it("returns false for HTTP 401", () => {
    expect(isRetryable(new Error("HTTP 401: Unauthorized"))).toBe(false);
  });

  it("returns false for HTTP 404", () => {
    expect(isRetryable(new Error("HTTP 404"))).toBe(false);
  });

  it("returns true for ECONNRESET", () => {
    const err = new Error("Connection reset");
    (err as unknown as { code: string }).code = "ECONNRESET";
    expect(isRetryable(err)).toBe(true);
  });

  it("returns true for ECONNREFUSED", () => {
    const err = new Error("Connection refused");
    (err as unknown as { code: string }).code = "ECONNREFUSED";
    expect(isRetryable(err)).toBe(true);
  });

  it("returns true for ETIMEDOUT", () => {
    const err = new Error("Timed out");
    (err as unknown as { code: string }).code = "ETIMEDOUT";
    expect(isRetryable(err)).toBe(true);
  });

  it("returns false for generic errors", () => {
    expect(isRetryable(new Error("Something went wrong"))).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on retryable error and succeeds", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("HTTP 500: Internal Server Error"))
      .mockResolvedValue("ok");

    const result = await withRetry(fn, { initialDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws immediately on non-retryable error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("HTTP 400: Bad Request"));

    await expect(withRetry(fn, { initialDelayMs: 1 })).rejects.toThrow("HTTP 400");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws after max attempts", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("HTTP 500: Internal Server Error"));

    await expect(withRetry(fn, { maxAttempts: 3, initialDelayMs: 1 })).rejects.toThrow("HTTP 500");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws immediately on AbortError", async () => {
    const err = new Error("Aborted");
    err.name = "AbortError";
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { initialDelayMs: 1 })).rejects.toThrow("Aborted");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("respects abort signal during delay", async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockRejectedValue(new Error("HTTP 500"));

    const promise = withRetry(fn, {
      maxAttempts: 5,
      initialDelayMs: 10000,
      signal: controller.signal,
    });

    // Abort quickly
    setTimeout(() => controller.abort(), 10);

    await expect(promise).rejects.toThrow();
    // Should have attempted only once before the delay was aborted
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("uses exponential backoff", async () => {
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return realSetTimeout(fn, 1); // Execute immediately for test speed
    });

    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("HTTP 500"))
      .mockRejectedValueOnce(new Error("HTTP 500"))
      .mockResolvedValue("ok");

    await withRetry(fn, { maxAttempts: 3, initialDelayMs: 100, maxDelayMs: 5000 });

    // First retry: 100ms, second retry: 200ms
    expect(delays).toContain(100);
    expect(delays).toContain(200);

    vi.restoreAllMocks();
  });
});

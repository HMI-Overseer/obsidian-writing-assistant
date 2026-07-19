import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTimeoutSignal } from "../../../src/api/httpTransport";

describe("createTimeoutSignal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts with an AbortError once the timeout elapses", () => {
    const { signal } = createTimeoutSignal(3000);
    expect(signal.aborted).toBe(false);

    vi.advanceTimersByTime(3000);

    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).name).toBe("AbortError");
  });

  it("does not abort before the timeout elapses", () => {
    const { signal } = createTimeoutSignal(3000);
    vi.advanceTimersByTime(2999);
    expect(signal.aborted).toBe(false);
  });

  it("stops the timer after cleanup so it never aborts late", () => {
    const { signal, cleanup } = createTimeoutSignal(3000);
    cleanup();
    vi.advanceTimersByTime(10000);
    expect(signal.aborted).toBe(false);
  });

  it("forwards a parent abort immediately, preserving the reason", () => {
    const parent = new AbortController();
    const { signal } = createTimeoutSignal(3000, parent.signal);

    const reason = new Error("stopped by the user");
    parent.abort(reason);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);
  });

  it("is already aborted when the parent was aborted before creation", () => {
    const parent = new AbortController();
    parent.abort();
    const { signal } = createTimeoutSignal(3000, parent.signal);
    expect(signal.aborted).toBe(true);
  });
});

import { describe, expect, it, vi } from "vitest";
import { createStreamMetadataGate } from "../../../src/api/assistantStreamRun";
import type { ProviderDisposalHooks } from "../../../src/api/assistantStreamRun";
import {
  createLinkedAbort,
  createOwnedStreamRun,
  detachedAttemptContext,
} from "../../../src/api/assistantStreamRuntime";

/**
 * RFC-0011 phase 2: the owned-run contract.
 *
 * Every provider goes through one factory, so these cover the paths each client
 * previously had to remember for itself: iterator closure, metadata resolution,
 * idempotent cancellation, and the two-deadline disposal ladder.
 */

const never = (): Promise<void> => new Promise<void>(() => {});

/** Disposal hooks with deliberately tiny deadlines; the ladder is what is under test. */
function hooks(
  overrides: Partial<ProviderDisposalHooks> = {},
): ProviderDisposalHooks {
  return {
    requestGracefulStop: () => Promise.resolve(),
    hardDispose: () => Promise.resolve(),
    gracefulDeadlineMs: 10,
    hardDisposeDeadlineMs: 10,
    ...overrides,
  };
}

function runOver(
  events: string[],
  options: {
    disposal?: ProviderDisposalHooks;
    abort?: (reason: string) => void;
    throwAt?: Error;
    openThrows?: Error;
  } = {},
) {
  const state = { closed: false };
  const metadata = createStreamMetadataGate();
  async function* source(): AsyncGenerator<string> {
    if (options.openThrows) throw options.openThrows;
    try {
      for (const event of events) yield event;
      if (options.throwAt) throw options.throwAt;
    } finally {
      state.closed = true;
    }
  }
  const run = createOwnedStreamRun<string>({
    attempt: detachedAttemptContext("turn-x"),
    provider: "anthropic",
    open: source,
    metadata,
    ...(options.abort ? { abort: options.abort } : {}),
    ...(options.disposal ? { disposal: options.disposal } : {}),
  });
  return { run, state };
}

describe("createOwnedStreamRun exhaustion and failure", () => {
  it("settles proven with no reason when the source exhausts", async () => {
    const { run, state } = runOver(["a", "b"]);
    const seen: string[] = [];
    for await (const event of run.events) seen.push(event);

    expect(seen).toEqual(["a", "b"]);
    expect(state.closed).toBe(true);
    const settlement = await run.settled;
    expect(settlement.quiescence).toBe("proven");
    expect(settlement.reason).toBeNull();
  });

  it("settles a zero-event attempt", async () => {
    const { run } = runOver([]);
    for await (const _event of run.events) void _event;

    await expect(run.settled).resolves.toMatchObject({ quiescence: "proven" });
    await expect(
      Promise.all([run.usage, run.stopReason, run.replayCapsule, run.replayEvidence]),
    ).resolves.toBeDefined();
  });

  it("settles provider_failed on a mid-stream throw and rethrows the original error", async () => {
    const { run } = runOver(["a"], { throwAt: new Error("upstream reset") });

    await expect(
      (async () => {
        for await (const _event of run.events) void _event;
      })(),
    ).rejects.toThrow("upstream reset");

    const settlement = await run.settled;
    expect(settlement.reason).toBe("provider_failed");
  });

  it("settles when opening the source throws", async () => {
    const { run } = runOver([], { openThrows: new Error("could not construct") });

    await expect(
      (async () => {
        for await (const _event of run.events) void _event;
      })(),
    ).rejects.toThrow("could not construct");

    await expect(run.settled).resolves.toBeDefined();
  });

  it("resolves every metadata promise exactly once across cancel and exhaustion", async () => {
    const metadata = createStreamMetadataGate();
    const settled: string[] = [];
    metadata.stopReason.settle("tool_use");
    async function* source(): AsyncGenerator<string> {
      yield "a";
    }
    const run = createOwnedStreamRun<string>({
      attempt: detachedAttemptContext("turn-x"),
      provider: "anthropic",
      open: source,
      metadata,
    });
    void run.stopReason.then((value) => settled.push(value));

    for await (const _event of run.events) void _event;
    await run.cancel("user_stop");
    await run.stopReason;

    // The pre-settled value survives: `settleRemaining()` fills gaps, it does not
    // overwrite terminal facts a translator already selected.
    expect(settled).toEqual(["tool_use"]);
  });
});

describe("createOwnedStreamRun cancellation", () => {
  it("aborts the transport, closes the source, and settles proven with no disposal hooks", async () => {
    const abort = vi.fn();
    const { run, state } = runOver(["a", "b", "c"], { abort });
    const iterator = run.events[Symbol.asyncIterator]();
    await iterator.next();

    await run.cancel("user_stop");

    expect(abort).toHaveBeenCalledWith("user_stop");
    expect(state.closed).toBe(true);
    const settlement = await run.settled;
    expect(settlement.reason).toBe("user_stop");
    expect(settlement.quiescence).toBe("proven");
    expect(settlement.hardDisposed).toBe(false);
  });

  it("is idempotent and keeps the first reason", async () => {
    const abort = vi.fn();
    const { run } = runOver(["a"], { abort });
    const iterator = run.events[Symbol.asyncIterator]();
    await iterator.next();

    await Promise.all([run.cancel("user_stop"), run.cancel("downstream_failed")]);
    await run.cancel("consumer_returned");

    // A user Stop that arrives before the unwind is not overwritten by the
    // `consumer_returned` the unwind produces.
    const settlement = await run.settled;
    expect(settlement.reason).toBe("user_stop");
    expect(abort).toHaveBeenCalledTimes(1);
  });
});

describe("createOwnedStreamRun disposal ladder", () => {
  it("invokes hard disposal when the graceful deadline expires", async () => {
    const hardDispose = vi.fn(() => Promise.resolve());
    const { run } = runOver(["a"], {
      disposal: hooks({ requestGracefulStop: never, hardDispose }),
    });
    const iterator = run.events[Symbol.asyncIterator]();
    await iterator.next();

    await run.cancel("user_stop");

    expect(hardDispose).toHaveBeenCalledTimes(1);
    const settlement = await run.settled;
    // Hard disposal ran, so quiescence is forced: it is never proof of exact
    // capture or session validity, even when the kill itself succeeded.
    expect(settlement.quiescence).toBe("forced");
    expect(settlement.hardDisposed).toBe(true);
    expect(settlement.diagnostics.map((d) => d.code)).toContain(
      "graceful_stop_deadline_expired",
    );
  });

  it("forces settlement when hard disposal cannot prove exit either", async () => {
    const { run } = runOver(["a"], {
      disposal: hooks({ requestGracefulStop: never, hardDispose: never }),
    });
    const iterator = run.events[Symbol.asyncIterator]();
    await iterator.next();

    await run.cancel("capture_failed");

    const settlement = await run.settled;
    expect(settlement.quiescence).toBe("forced");
    expect(settlement.reason).toBe("capture_failed");
    expect(settlement.diagnostics.map((d) => d.code)).toContain(
      "hard_dispose_deadline_expired",
    );
  });

  it("skips straight to hard disposal when the provider refuses the graceful tier", async () => {
    const hardDispose = vi.fn(() => Promise.resolve());
    const { run } = runOver(["a"], {
      disposal: hooks({
        requestGracefulStop: (reason) =>
          reason === "capture_failed"
            ? Promise.reject(new Error("capture failure disposes the session"))
            : Promise.resolve(),
        hardDispose,
      }),
    });
    const iterator = run.events[Symbol.asyncIterator]();
    await iterator.next();

    await run.cancel("capture_failed");

    expect(hardDispose).toHaveBeenCalledTimes(1);
    const settlement = await run.settled;
    expect(settlement.quiescence).toBe("forced");
    expect(settlement.diagnostics.map((d) => d.code)).toContain(
      "graceful_stop_refused",
    );
  });

  it("stays proven and skips hard disposal when the graceful tier succeeds", async () => {
    const hardDispose = vi.fn(() => Promise.resolve());
    const { run, state } = runOver(["a"], { disposal: hooks({ hardDispose }) });
    const iterator = run.events[Symbol.asyncIterator]();
    await iterator.next();

    await run.cancel("user_stop");

    expect(hardDispose).not.toHaveBeenCalled();
    expect(state.closed).toBe(true);
    await expect(run.settled).resolves.toMatchObject({
      quiescence: "proven",
      hardDisposed: false,
    });
  });
});

describe("createLinkedAbort", () => {
  it("fires when the lease signal fires without replacing it", () => {
    const lease = new AbortController();
    const attempt = detachedAttemptContext("turn-x", lease.signal);
    const linked = createLinkedAbort(attempt);

    expect(linked.signal.aborted).toBe(false);
    lease.abort();

    expect(linked.signal.aborted).toBe(true);
    expect(attempt.signal.aborted).toBe(true);
  });

  it("stops only its own attempt when aborted directly", () => {
    const lease = new AbortController();
    const attempt = detachedAttemptContext("turn-x", lease.signal);
    const linked = createLinkedAbort(attempt);

    linked.abort();

    expect(linked.signal.aborted).toBe(true);
    expect(lease.signal.aborted).toBe(false);
  });

  it("is already aborted when the lease was aborted first", () => {
    const lease = new AbortController();
    lease.abort();
    const linked = createLinkedAbort(detachedAttemptContext("turn-x", lease.signal));

    expect(linked.signal.aborted).toBe(true);
  });
});

import { describe, it, expect, vi } from "vitest";
import {
  CaptureFrameQueue,
  createAssistantCaptureStream,
} from "../../src/api/assistantCaptureStream";
import type { AssistantCaptureBatch } from "../../src/api/assistantCapture";
import { createCaptureBatch } from "../../src/api/assistantCapture";
import {
  createOwnedStreamRun,
  detachedAttemptContext,
} from "../../src/api/assistantStreamRuntime";
import { createStreamMetadataGate } from "../../src/api/assistantStreamRun";
import type { AssistantStreamRun } from "../../src/api/assistantStreamRun";
import { streamWithRetry } from "../../src/api/retry";
import { TurnRunOwner } from "../../src/chat/streaming/TurnRunOwner";
import type {
  AssistantStreamEvent,
  AssistantStreamMetadata,
} from "../../src/api/usageTypes";

/**
 * RFC-0011 ownership and termination.
 *
 * Phase 0 wrote each of these twice: a plain `it` recording what the tree did, and
 * an `it.fails` stating what RFC-0011 requires. Phase 2 closed the defects, so the
 * "what it did" halves are gone and the required halves are plain `it` now. See
 * docs/work/plans/notes/2026-07-27-provider-frame-phase0-protocol-characterization.md.
 */

function metadata(): AssistantStreamMetadata {
  return {
    usage: null,
    stopReason: "end_turn",
    replayCapsule: null,
    replayEvidence: {
      tier: "textual",
      capabilities: {
        captureOrder: "text_only",
        toolCorrelation: "none",
        coldReplay: "textual",
        nativeResume: false,
      },
    },
  };
}

/**
 * A raw text stream whose `finally` records that the generator was closed. A
 * generator abandoned mid-`yield` never runs it, so `closed` is the observable
 * proof that an owner did or did not return the iterator it acquired.
 */
function instrumentedRawStream(chunks: string[]): {
  stream: AsyncGenerator<string>;
  state: { closed: boolean; delivered: number };
} {
  const state = { closed: false, delivered: 0 };
  async function* stream(): AsyncGenerator<string> {
    try {
      for (const chunk of chunks) {
        state.delivered += 1;
        yield chunk;
      }
    } finally {
      state.closed = true;
    }
  }
  return { stream: stream(), state };
}

/**
 * A translator double for the direct-HTTP bridge. It turns each raw SSE payload
 * into one fact, which the queue then seals into one batch, so these tests
 * exercise the real frame-preserving path rather than a flat event list.
 */
function frameQueue(): CaptureFrameQueue {
  let index = 0;
  return new CaptureFrameQueue({
    translate: () => {
      index += 1;
      return [{ type: "segment_start" as const, segmentId: `s${index}` }];
    },
    finishEvents: () => [],
    metadata,
    providerMessageKey: () => "msg_1",
  });
}

describe("createAssistantCaptureStream ownership", () => {
  // Criterion 19, fixed in phase 2. Promoted from `it.fails` when the defect closed.
  it("closes the raw transport iterator on early consumer return", async () => {
    const { stream, state } = instrumentedRawStream(["a", "b", "c"]);
    const frames = frameQueue();
    const result = createAssistantCaptureStream(
      stream,
      frames,
      { translate: () => [], finishEvents: () => [], metadata, providerMessageKey: () => undefined },
      { attempt: detachedAttemptContext("t"), provider: "anthropic", abort: () => {} },
    );

    frames.onPayload({}, "{}");
    const iterator = result.events[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.(undefined);

    expect(state.closed).toBe(true);
  });

  it("aborts the transport when the consumer returns early", async () => {
    const { stream } = instrumentedRawStream(["a", "b", "c"]);
    const frames = frameQueue();
    const abort = vi.fn();
    const result = createAssistantCaptureStream(
      stream,
      frames,
      { translate: () => [], finishEvents: () => [], metadata, providerMessageKey: () => undefined },
      { attempt: detachedAttemptContext("t"), provider: "anthropic", abort },
    );

    frames.onPayload({}, "{}");
    const iterator = result.events[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.(undefined);

    expect(abort).toHaveBeenCalled();
  });

  it("still resolves every metadata promise on early consumer return", async () => {
    const { stream } = instrumentedRawStream(["a"]);
    const frames = frameQueue();
    const result = createAssistantCaptureStream(
      stream,
      frames,
      { translate: () => [], finishEvents: () => [], metadata, providerMessageKey: () => undefined },
      { attempt: detachedAttemptContext("t"), provider: "anthropic", abort: () => {} },
    );

    frames.onPayload({}, "{}");
    const iterator = result.events[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.(undefined);

    await expect(
      Promise.all([
        result.usage,
        result.stopReason,
        result.replayCapsule,
        result.replayEvidence,
      ]),
    ).resolves.toBeDefined();
  });

  it("settles once with the consumer_returned reason", async () => {
    const { stream } = instrumentedRawStream(["a", "b"]);
    const frames = frameQueue();
    const result = createAssistantCaptureStream(
      stream,
      frames,
      { translate: () => [], finishEvents: () => [], metadata, providerMessageKey: () => undefined },
      { attempt: detachedAttemptContext("t"), provider: "anthropic", abort: () => {} },
    );

    frames.onPayload({}, "{}");
    const iterator = result.events[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.(undefined);

    const settlement = await result.settled;
    expect(settlement.reason).toBe("consumer_returned");
    expect(settlement.quiescence).toBe("proven");
    expect(settlement.hardDisposed).toBe(false);
  });
});

/** One fact per batch, the honest shape for a double with no frame structure. */
function batchOf(
  event: AssistantStreamEvent,
  leaseId: string,
  ordinal: number,
): AssistantCaptureBatch {
  return createCaptureBatch({
    leaseId,
    frameKey: `derived-fake-${ordinal}`,
    frameKeySource: "derived",
    facts: [event],
  });
}

/** An owned run over a fixed event list whose closure is observable. */
function instrumentedRun(events: AssistantStreamEvent[], label = "attempt"): {
  run: AssistantStreamRun;
  state: { closed: boolean };
} {
  const state = { closed: false };
  const gate = createStreamMetadataGate();
  async function* generator(): AsyncGenerator<AssistantCaptureBatch> {
    try {
      let ordinal = 0;
      for (const event of events) yield batchOf(event, label, (ordinal += 1));
    } finally {
      state.closed = true;
      gate.settleRemaining();
    }
  }
  return {
    run: createOwnedStreamRun({
      attempt: detachedAttemptContext(label),
      provider: "anthropic",
      open: generator,
      metadata: gate,
    }),
    state,
  };
}

describe("streamWithRetry ownership", () => {
  // Criterion 19, fixed in phase 2. Promoted from `it.fails` when the defect closed.
  it("closes the committed attempt when its consumer returns early", async () => {
    const { run, state } = instrumentedRun([
      { type: "segment_start", segmentId: "s1" },
      { type: "prose_delta", segmentId: "s1", delta: "hello" },
      { type: "prose_delta", segmentId: "s1", delta: " world" },
    ]);
    const owner = new TurnRunOwner("turn-1");
    const wrapped = streamWithRetry(() => run, owner);

    const iterator = wrapped.events[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.(undefined);

    expect(state.closed).toBe(true);
  });

  it("cancels and settles the committed attempt on early consumer return", async () => {
    const { run } = instrumentedRun([
      { type: "segment_start", segmentId: "s1" },
      { type: "prose_delta", segmentId: "s1", delta: "hello" },
    ]);
    const owner = new TurnRunOwner("turn-1");
    const wrapped = streamWithRetry(() => run, owner);

    const iterator = wrapped.events[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.(undefined);

    // Criterion 16: an abandoned committed attempt is cancelled, settled, and
    // closed rather than left producing into nothing.
    expect(owner.committedAttempt?.isQuiet).toBe(true);
    const settlement = await run.settled;
    expect(settlement.reason).toBe("consumer_returned");
  });

  it("proves the abandoned pre-commit attempt quiet before the next one opens", async () => {
    const closed: boolean[] = [];
    const priorClosedAtConstruction: Array<boolean | null> = [];
    const owner = new TurnRunOwner("turn-1");
    let attempt = 0;

    const makeStream = (): AssistantStreamRun<AssistantStreamEvent> => {
      const index = attempt++;
      closed.push(false);
      // The prior attempt must already be closed and settled at the instant this
      // one is constructed. Previously the failed attempt was simply dropped and
      // the backoff slept while it was potentially still running (criterion 16).
      priorClosedAtConstruction.push(index === 0 ? null : closed[index - 1]);
      const gate = createStreamMetadataGate();
      async function* generator(): AsyncGenerator<AssistantStreamEvent> {
        try {
          if (index === 0) throw new Error("HTTP 503 upstream");
          yield { type: "segment_start", segmentId: "s1" };
        } finally {
          closed[index] = true;
          gate.settleRemaining();
        }
      }
      return createOwnedStreamRun({
        attempt: detachedAttemptContext(`a${index}`),
        provider: "anthropic",
        open: generator,
        metadata: gate,
      });
    };

    const wrapped = streamWithRetry(makeStream, owner, { initialDelayMs: 0 });
    const seen: AssistantStreamEvent[] = [];
    for await (const event of wrapped.events) seen.push(event);

    expect(seen).toHaveLength(1);
    expect(closed[0]).toBe(true);
    expect(attempt).toBe(2);
    expect(priorClosedAtConstruction).toEqual([null, true]);
  });

  it("exposes cancellation and settlement", async () => {
    const { run } = instrumentedRun([]);
    const owner = new TurnRunOwner("turn-1");
    const wrapped = streamWithRetry(() => run, owner);

    // Criterion 15 and 20: an owner can ask an attempt to stop and can wait for
    // it to settle. `StreamResult` exposed events and metadata only.
    expect(typeof wrapped.cancel).toBe("function");
    expect(wrapped.settled).toBeInstanceOf(Promise);
    await wrapped.cancel("user_stop");
    await expect(wrapped.settled).resolves.toBeDefined();
  });

  it("settles a factory throw without leaving an unowned lease", async () => {
    const owner = new TurnRunOwner("turn-1");
    const wrapped = streamWithRetry(() => {
      throw new Error("could not construct the provider stream");
    }, owner);

    await expect(
      (async () => {
        for await (const _event of wrapped.events) void _event;
      })(),
    ).rejects.toThrow("could not construct");

    // Criterion 15: the lease exists before construction, so a throw settles it.
    expect(owner.isQuiet).toBe(true);
    await expect(wrapped.settled).resolves.toBeDefined();
  });

  it("refuses to retry once a consequential callback entered", async () => {
    const owner = new TurnRunOwner("turn-1");
    let attempts = 0;
    const makeStream = (): AssistantStreamRun<AssistantStreamEvent> => {
      attempts += 1;
      const gate = createStreamMetadataGate();
      async function* generator(): AsyncGenerator<AssistantStreamEvent> {
        try {
          throw new Error("HTTP 503 upstream");
        } finally {
          gate.settleRemaining();
        }
      }
      return createOwnedStreamRun({
        attempt: detachedAttemptContext(`a${attempts}`),
        provider: "anthropic",
        open: generator,
        metadata: gate,
      });
    };

    // Phase 5 wires the Claude callback surfaces that set this; phase 2 owns the
    // flag and the refusal it drives (criterion 16).
    owner.noteConsequentialCallback();
    const wrapped = streamWithRetry(makeStream, owner, { initialDelayMs: 0 });
    await expect(
      (async () => {
        for await (const _event of wrapped.events) void _event;
      })(),
    ).rejects.toThrow("HTTP 503");

    expect(attempts).toBe(1);
  });

  it("resolves wrapper metadata on a zero-event attempt", async () => {
    const { run } = instrumentedRun([]);
    const owner = new TurnRunOwner("turn-1");
    const wrapped = streamWithRetry(() => run, owner);

    for await (const _event of wrapped.events) void _event;

    await expect(
      Promise.all([
        wrapped.usage,
        wrapped.stopReason,
        wrapped.replayCapsule,
        wrapped.replayEvidence,
        wrapped.settled,
      ]),
    ).resolves.toBeDefined();
  });
});

describe("downstream failure stops the provider", () => {
  it("cancels the run with downstream_failed when the reducer throws", async () => {
    const { run, state } = instrumentedRun([
      { type: "segment_start", segmentId: "s1" },
      { type: "prose_delta", segmentId: "s1", delta: "hello" },
    ]);
    const owner = new TurnRunOwner("turn-1");
    const wrapped = streamWithRetry(() => run, owner);
    const applyBatch = vi.fn((batch: AssistantCaptureBatch) => {
      if (batch.facts.some((fact) => fact.type === "prose_delta")) {
        throw new Error("builder rejected the batch");
      }
    });

    let thrown: unknown = null;
    try {
      for await (const batch of wrapped.events) {
        try {
          applyBatch(batch);
        } catch (error) {
          // What runToolLoop does: name the reason before unwinding, so the
          // `consumer_returned` the unwind produces cannot claim it first
          // (invariant 11, criterion 18).
          await owner.cancelAll("downstream_failed");
          throw error;
        }
      }
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(state.closed).toBe(true);
    const settlement = await run.settled;
    expect(settlement.reason).toBe("downstream_failed");
  });
});

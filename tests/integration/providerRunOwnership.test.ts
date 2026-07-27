import { describe, it, expect, vi } from "vitest";
import { createAssistantEventStream } from "../../src/api/assistantEventStream";
import { streamWithRetry } from "../../src/api/retry";
import type {
  AssistantStreamEvent,
  AssistantStreamMetadata,
  StreamResult,
} from "../../src/api/usageTypes";

/**
 * RFC-0011 phase 0: ownership and termination characterization.
 *
 * Each `it` records what the current tree actually does. Each `it.fails` states
 * the invariant RFC-0011 requires; it passes while the defect stands and turns
 * red the moment the defect is fixed, which is the signal to promote it in the
 * phase named in its comment. See
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

describe("createAssistantEventStream ownership", () => {
  it("leaves its manually acquired raw iterator open when the consumer returns early", async () => {
    const { stream, state } = instrumentedRawStream(["a", "b", "c"]);
    const pending: AssistantStreamEvent[] = [];
    const result = createAssistantEventStream(
      stream,
      pending,
      { finishEvents: () => [], metadata },
      undefined,
    );

    pending.push({ type: "segment_start", segmentId: "s1" });
    const iterator = result.events[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.(undefined);

    // Invariant 19 and criterion 19: every manually acquired iterator is closed
    // on early return. `events()` obtains the raw iterator inside its `try` and
    // never returns it, so the transport generator stays suspended.
    expect(state.closed).toBe(false);
  });

  // Criterion 19, fixed in phase 2.
  it.fails("closes the raw transport iterator on early consumer return", async () => {
    const { stream, state } = instrumentedRawStream(["a", "b", "c"]);
    const pending: AssistantStreamEvent[] = [];
    const result = createAssistantEventStream(
      stream,
      pending,
      { finishEvents: () => [], metadata },
      undefined,
    );

    pending.push({ type: "segment_start", segmentId: "s1" });
    const iterator = result.events[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.(undefined);

    expect(state.closed).toBe(true);
  });

  it("still resolves every metadata promise on early consumer return", async () => {
    const { stream } = instrumentedRawStream(["a"]);
    const pending: AssistantStreamEvent[] = [];
    const result = createAssistantEventStream(
      stream,
      pending,
      { finishEvents: () => [], metadata },
      undefined,
    );

    pending.push({ type: "segment_start", segmentId: "s1" });
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
});

/** A stream whose generator records closure and whose cancellation is observable. */
function instrumentedStreamResult(events: AssistantStreamEvent[]): {
  result: StreamResult;
  state: { closed: boolean; aborted: boolean };
} {
  const state = { closed: false, aborted: false };
  async function* generator(): AsyncGenerator<AssistantStreamEvent> {
    try {
      for (const event of events) yield event;
    } finally {
      state.closed = true;
    }
  }
  return {
    result: {
      events: generator(),
      usage: Promise.resolve(null),
      stopReason: Promise.resolve("end_turn"),
      replayCapsule: Promise.resolve(null),
      replayEvidence: Promise.resolve(metadata().replayEvidence),
    },
    state,
  };
}

describe("streamWithRetry ownership", () => {
  it("leaves the committed attempt open when its consumer returns early", async () => {
    const { result, state } = instrumentedStreamResult([
      { type: "segment_start", segmentId: "s1" },
      { type: "prose_delta", segmentId: "s1", delta: "hello" },
      { type: "prose_delta", segmentId: "s1", delta: " world" },
    ]);
    const wrapped = streamWithRetry(() => result);

    const iterator = wrapped.events[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.(undefined);

    // Criterion 16 and 19: an abandoned or early-returned committed attempt must
    // be cancelled, settled, and closed. `events()` drains the committed
    // iterator inside its loop with no `finally` that returns it.
    expect(state.closed).toBe(false);
  });

  // Criterion 19, fixed in phase 2.
  it.fails("closes the committed attempt when its consumer returns early", async () => {
    const { result, state } = instrumentedStreamResult([
      { type: "segment_start", segmentId: "s1" },
      { type: "prose_delta", segmentId: "s1", delta: "hello" },
      { type: "prose_delta", segmentId: "s1", delta: " world" },
    ]);
    const wrapped = streamWithRetry(() => result);

    const iterator = wrapped.events[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.(undefined);

    expect(state.closed).toBe(true);
  });

  it("leaves an abandoned pre-commit attempt open before retrying", async () => {
    const closed: boolean[] = [];
    let attempt = 0;
    const makeStream = (): StreamResult => {
      const index = attempt++;
      closed.push(false);
      async function* generator(): AsyncGenerator<AssistantStreamEvent> {
        try {
          if (index === 0) throw new Error("HTTP 503 upstream");
          yield { type: "segment_start", segmentId: "s1" };
        } finally {
          closed[index] = true;
        }
      }
      return {
        events: generator(),
        usage: Promise.resolve(null),
        stopReason: Promise.resolve("end_turn"),
        replayCapsule: Promise.resolve(null),
        replayEvidence: Promise.resolve(metadata().replayEvidence),
      };
    };

    const wrapped = streamWithRetry(makeStream, { initialDelayMs: 0 });
    const seen: AssistantStreamEvent[] = [];
    for await (const event of wrapped.events) seen.push(event);

    expect(seen).toHaveLength(1);
    // A generator that throws before its first yield does run its `finally`, so
    // the first attempt is closed by the throw, not by an owner. Nothing in the
    // wrapper proves quiescence before the next attempt starts (criterion 16).
    expect(closed[0]).toBe(true);
    expect(attempt).toBe(2);
  });

  it("has no cancellation or settlement surface at all", () => {
    const { result } = instrumentedStreamResult([]);
    const wrapped = streamWithRetry(() => result);

    // Criterion 15 and 20. `StreamResult` exposes events and metadata only, so
    // no owner can ask an attempt to stop or wait for it to settle.
    expect("cancel" in wrapped).toBe(false);
    expect("settled" in wrapped).toBe(false);
  });
});

describe("downstream failure does not stop the provider", () => {
  it("keeps the provider stream alive when the reducer throws", async () => {
    const { result, state } = instrumentedStreamResult([
      { type: "segment_start", segmentId: "s1" },
      { type: "prose_delta", segmentId: "s1", delta: "hello" },
    ]);
    const applyEvent = vi.fn((event: AssistantStreamEvent) => {
      if (event.type === "prose_delta") throw new Error("builder rejected the batch");
    });

    let thrown: unknown = null;
    try {
      for await (const event of result.events) applyEvent(event);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    // Invariant 11 and criterion 18: a downstream failure must trigger explicit
    // provider cancellation. `for await` does return the generator, but nothing
    // cancels the upstream provider run, and no owner awaits its settlement.
    expect(state.closed).toBe(true);
    expect(state.aborted).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";
import { streamWithRetry } from "../../../src/api/retry";
import type {
  AssistantStreamEvent,
  StopReason,
  StreamResult,
  UsageResult,
} from "../../../src/api/usageTypes";
import type {
  AssistantReplayEvidence,
  ProviderReplayCapsule,
} from "../../../src/shared/types";

const STRUCTURAL_EVIDENCE: AssistantReplayEvidence = {
  tier: "structural",
  capabilities: {
    captureOrder: "exact",
    toolCorrelation: "provider_id",
    coldReplay: "structural",
    nativeResume: false,
  },
};

type StreamShape = {
  events?: AssistantStreamEvent[];
  /** Thrown after events are yielded, or before the first event when the list is empty. */
  throwAfter?: Error;
  usage?: UsageResult | null;
  stopReason?: StopReason;
  replayCapsule?: ProviderReplayCapsule | null;
  replayEvidence?: AssistantReplayEvidence;
};

/**
 * Build a StreamResult honoring the runtime contract: terminal facts resolve only
 * once the event generator is fully consumed.
 */
function makeStream(shape: StreamShape): StreamResult {
  let resolveUsage!: (value: UsageResult | null) => void;
  let resolveStopReason!: (value: StopReason) => void;
  let resolveReplayCapsule!: (value: ProviderReplayCapsule | null) => void;
  let resolveReplayEvidence!: (value: AssistantReplayEvidence) => void;
  const usage = new Promise<UsageResult | null>((resolve) => {
    resolveUsage = resolve;
  });
  const stopReason = new Promise<StopReason>((resolve) => {
    resolveStopReason = resolve;
  });
  const replayCapsule = new Promise<ProviderReplayCapsule | null>((resolve) => {
    resolveReplayCapsule = resolve;
  });
  const replayEvidence = new Promise<AssistantReplayEvidence>((resolve) => {
    resolveReplayEvidence = resolve;
  });

  async function* events(): AsyncGenerator<AssistantStreamEvent> {
    try {
      for (const event of shape.events ?? []) yield event;
      if (shape.throwAfter) throw shape.throwAfter;
    } finally {
      resolveUsage(shape.usage ?? null);
      resolveStopReason(shape.stopReason ?? "end_turn");
      resolveReplayCapsule(shape.replayCapsule ?? null);
      resolveReplayEvidence(shape.replayEvidence ?? STRUCTURAL_EVIDENCE);
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

async function collect(result: StreamResult): Promise<AssistantStreamEvent[]> {
  const output: AssistantStreamEvent[] = [];
  for await (const event of result.events) output.push(event);
  return output;
}

describe("streamWithRetry", () => {
  const start: AssistantStreamEvent = {
    type: "segment_start",
    segmentId: "segment-committed",
  };

  it("passes through ordered events and terminal facts on first success", async () => {
    const end: AssistantStreamEvent = {
      type: "segment_end",
      segmentId: "segment-committed",
    };
    const factory = vi.fn(() =>
      makeStream({
        events: [start, end],
        usage: { inputTokens: 1, outputTokens: 2 },
        stopReason: "end_turn",
      }),
    );

    const result = streamWithRetry(factory, { initialDelayMs: 1 });
    expect(await collect(result)).toEqual([start, end]);
    expect(await result.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
    expect(await result.stopReason).toBe("end_turn");
    expect(await result.replayEvidence).toEqual(STRUCTURAL_EVIDENCE);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("retries an error before the attempt publishes any ordered event", async () => {
    const factory = vi
      .fn<() => StreamResult>()
      .mockReturnValueOnce(
        makeStream({ throwAfter: new Error("HTTP 529: overloaded") }),
      )
      .mockReturnValueOnce(
        makeStream({
          events: [start],
          usage: { inputTokens: 3, outputTokens: 4 },
        }),
      );

    const result = streamWithRetry(factory, { initialDelayMs: 1 });
    expect(await collect(result)).toEqual([start]);
    expect(await result.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-retryable first error", async () => {
    const factory = vi.fn(() =>
      makeStream({ throwAfter: new Error("HTTP 400: bad request") }),
    );

    const result = streamWithRetry(factory, { initialDelayMs: 1 });
    await expect(collect(result)).rejects.toThrow("HTTP 400");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("does not retry once any ordered event has been published", async () => {
    const factory = vi.fn(() =>
      makeStream({
        events: [start],
        throwAfter: new Error("HTTP 500: server error"),
      }),
    );

    const result = streamWithRetry(factory, { initialDelayMs: 1 });
    const output: AssistantStreamEvent[] = [];
    await expect(
      (async () => {
        for await (const event of result.events) output.push(event);
      })(),
    ).rejects.toThrow("HTTP 500");
    expect(output).toEqual([start]);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("exhausts rejected attempts without publishing their events", async () => {
    const factory = vi.fn(() =>
      makeStream({ throwAfter: new Error("HTTP 503: unavailable") }),
    );

    const result = streamWithRetry(factory, {
      maxAttempts: 3,
      initialDelayMs: 1,
    });
    await expect(collect(result)).rejects.toThrow("HTTP 503");
    expect(factory).toHaveBeenCalledTimes(3);
    expect(await result.usage).toBeNull();
    expect(await result.stopReason).toBe("unknown");
    expect(await result.replayCapsule).toBeNull();
    expect(await result.replayEvidence).toEqual({
      tier: "textual",
      capabilities: {
        captureOrder: "text_only",
        toolCorrelation: "none",
        coldReplay: "textual",
        nativeResume: false,
      },
      loweredReason: "stream_attempt_failed_before_commit",
    });
  });

  it("does not retry an AbortError", async () => {
    const abort = new Error("Aborted");
    abort.name = "AbortError";
    const factory = vi.fn(() => makeStream({ throwAfter: abort }));

    const result = streamWithRetry(factory, { initialDelayMs: 1 });
    await expect(collect(result)).rejects.toThrow("Aborted");
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

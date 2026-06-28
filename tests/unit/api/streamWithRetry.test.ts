import { describe, it, expect, vi } from "vitest";
import { streamWithRetry } from "../../../src/api/retry";
import type { StreamResult, UsageResult, StopReason } from "../../../src/api/usageTypes";
import type { ToolCall } from "../../../src/tools/types";

type StreamShape = {
  deltas?: string[];
  /** Thrown after `deltas` are yielded (mid-stream) or, with empty deltas, before the first delta. */
  throwAfter?: Error;
  usage?: UsageResult | null;
  toolCalls?: ToolCall[] | null;
  stopReason?: StopReason;
};

/**
 * Build a StreamResult honoring the real contract: the deferred fields resolve only
 * once the delta generator is fully consumed (its finally runs), matching
 * AnthropicClient.stream's wrappedDeltas.
 */
function makeStream(shape: StreamShape): StreamResult {
  let resolveUsage!: (v: UsageResult | null) => void;
  let resolveToolCalls!: (v: ToolCall[] | null) => void;
  let resolveStopReason!: (v: StopReason) => void;
  const usage = new Promise<UsageResult | null>((r) => { resolveUsage = r; });
  const toolCalls = new Promise<ToolCall[] | null>((r) => { resolveToolCalls = r; });
  const stopReason = new Promise<StopReason>((r) => { resolveStopReason = r; });

  async function* gen(): AsyncGenerator<string> {
    try {
      for (const d of shape.deltas ?? []) yield d;
      if (shape.throwAfter) throw shape.throwAfter;
    } finally {
      resolveUsage(shape.usage ?? null);
      resolveToolCalls(shape.toolCalls ?? null);
      resolveStopReason(shape.stopReason ?? "end_turn");
    }
  }

  return { deltas: gen(), usage, toolCalls, stopReason };
}

async function collect(result: StreamResult): Promise<string[]> {
  const out: string[] = [];
  for await (const d of result.deltas) out.push(d);
  return out;
}

describe("streamWithRetry", () => {
  it("passes through deltas and forwards deferred fields on first success", async () => {
    const factory = vi.fn(() =>
      makeStream({
        deltas: ["a", "b"],
        usage: { inputTokens: 1, outputTokens: 2 },
        stopReason: "end_turn",
      }),
    );

    const result = streamWithRetry(factory, { initialDelayMs: 1 });
    expect(await collect(result)).toEqual(["a", "b"]);
    expect(await result.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
    expect(await result.stopReason).toBe("end_turn");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("retries a retryable error thrown before the first delta, then forwards the new attempt", async () => {
    const factory = vi
      .fn<[], StreamResult>()
      .mockReturnValueOnce(makeStream({ throwAfter: new Error("HTTP 529: overloaded") }))
      .mockReturnValueOnce(
        makeStream({ deltas: ["ok"], usage: { inputTokens: 3, outputTokens: 4 } }),
      );

    const result = streamWithRetry(factory, { initialDelayMs: 1 });
    expect(await collect(result)).toEqual(["ok"]);
    expect(await result.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-retryable first error", async () => {
    const factory = vi.fn(() => makeStream({ throwAfter: new Error("HTTP 400: bad request") }));

    const result = streamWithRetry(factory, { initialDelayMs: 1 });
    await expect(collect(result)).rejects.toThrow("HTTP 400");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("does not retry once the first delta has been yielded (mid-stream error propagates)", async () => {
    const factory = vi.fn(() =>
      makeStream({ deltas: ["partial"], throwAfter: new Error("HTTP 500: server error") }),
    );

    const result = streamWithRetry(factory, { initialDelayMs: 1 });
    const out: string[] = [];
    await expect(
      (async () => {
        for await (const d of result.deltas) out.push(d);
      })(),
    ).rejects.toThrow("HTTP 500");
    expect(out).toEqual(["partial"]);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting retries and still resolves deferred fields so awaiters never hang", async () => {
    const factory = vi.fn(() => makeStream({ throwAfter: new Error("HTTP 503: unavailable") }));

    const result = streamWithRetry(factory, { maxAttempts: 3, initialDelayMs: 1 });
    await expect(collect(result)).rejects.toThrow("HTTP 503");
    expect(factory).toHaveBeenCalledTimes(3);
    expect(await result.usage).toBeNull();
    expect(await result.toolCalls).toBeNull();
    expect(await result.stopReason).toBe("unknown");
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

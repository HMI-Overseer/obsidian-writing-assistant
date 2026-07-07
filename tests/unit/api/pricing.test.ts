import { describe, test, expect } from "vitest";
import { estimateCost } from "../../../src/api/pricing";
import type { UsageResult } from "../../../src/api/usageTypes";

function makeUsage(overrides: Partial<UsageResult> = {}): UsageResult {
  return {
    inputTokens: 0,
    outputTokens: 0,
    ...overrides,
  };
}

describe("estimateCost", () => {
  test("returns null for unknown model IDs", () => {
    expect(estimateCost("llama-3-8b", makeUsage({ inputTokens: 1000 }))).toBeNull();
  });

  test("returns null for LM Studio models", () => {
    expect(estimateCost("my-local-model", makeUsage({ inputTokens: 5000, outputTokens: 1000 }))).toBeNull();
  });

  test("returns 0 for zero tokens", () => {
    expect(estimateCost("claude-3-haiku-20240307", makeUsage())).toBe(0);
  });

  test("calculates correct cost for claude-3-haiku with date suffix", () => {
    const usage = makeUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    const cost = estimateCost("claude-3-haiku-20240307", usage);
    // $0.25/M input + $1.25/M output = $1.50
    expect(cost).toBeCloseTo(1.50, 4);
  });

  test("calculates correct cost for claude-3-5-haiku", () => {
    const usage = makeUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    const cost = estimateCost("claude-3-5-haiku-20241022", usage);
    // $0.80/M input + $4/M output = $4.80
    expect(cost).toBeCloseTo(4.80, 4);
  });

  test("calculates correct cost for claude-sonnet-4", () => {
    const usage = makeUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    const cost = estimateCost("claude-sonnet-4-20250514", usage);
    // $3/M input + $15/M output = $18
    expect(cost).toBeCloseTo(18, 4);
  });

  test("calculates correct cost for claude-opus-4", () => {
    const usage = makeUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    const cost = estimateCost("claude-opus-4-20250514", usage);
    // $15/M input + $75/M output = $90
    expect(cost).toBeCloseTo(90, 4);
  });

  test("includes cache creation tokens in cost", () => {
    const usage = makeUsage({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 1_000_000,
    });
    const cost = estimateCost("claude-sonnet-4-20250514", usage);
    // $3.75/M cache creation
    expect(cost).toBeCloseTo(3.75, 4);
  });

  test("includes cache read tokens in cost", () => {
    const usage = makeUsage({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 1_000_000,
    });
    const cost = estimateCost("claude-sonnet-4-20250514", usage);
    // $0.30/M cache read
    expect(cost).toBeCloseTo(0.30, 4);
  });

  test("uses longest matching prefix", () => {
    // "claude-3-5-sonnet" should match before "claude-3" prefix
    const usage = makeUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    const cost = estimateCost("claude-3-5-sonnet-20241022", usage);
    // $3/M input + $15/M output = $18
    expect(cost).toBeCloseTo(18, 4);
  });

  test("handles small token counts correctly", () => {
    const usage = makeUsage({ inputTokens: 2489, outputTokens: 12 });
    const cost = estimateCost("claude-3-haiku-20240307", usage);
    // (2489/1M) * $0.25 + (12/1M) * $1.25
    const expected = (2489 / 1_000_000) * 0.25 + (12 / 1_000_000) * 1.25;
    expect(cost).toBeCloseTo(expected, 8);
  });

  // --- Current-generation pricing (P1-4) ---

  test("prices the current Opus family (4.6/4.7/4.8) at $5/$25, not the legacy $15/$75", () => {
    const usage = makeUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    // $5/M input + $25/M output = $30, NOT the $90 the stale "claude-opus-4" prefix charged.
    expect(estimateCost("claude-opus-4-8", usage)).toBeCloseTo(30, 4);
    expect(estimateCost("claude-opus-4-7", usage)).toBeCloseTo(30, 4);
    expect(estimateCost("claude-opus-4-6", usage)).toBeCloseTo(30, 4);
    expect(estimateCost("claude-opus-4-5", usage)).toBeCloseTo(30, 4);
  });

  test("prices current Opus cache tokens at the dropped rate", () => {
    // $6.25/M cache write (1.25x input), $0.50/M cache read (0.1x input).
    expect(
      estimateCost("claude-opus-4-8", makeUsage({ cacheCreationInputTokens: 1_000_000 }))
    ).toBeCloseTo(6.25, 4);
    expect(
      estimateCost("claude-opus-4-8", makeUsage({ cacheReadInputTokens: 1_000_000 }))
    ).toBeCloseTo(0.5, 4);
  });

  test("keeps legacy Opus 4.0/4.1 distinct at $15/$75", () => {
    const usage = makeUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    // $15/M input + $75/M output = $90.
    expect(estimateCost("claude-opus-4-0", usage)).toBeCloseTo(90, 4);
    expect(estimateCost("claude-opus-4-1", usage)).toBeCloseTo(90, 4);
    expect(estimateCost("claude-opus-4-1-20250805", usage)).toBeCloseTo(90, 4);
  });

  test("prices Haiku 4.5 at $1/$5", () => {
    const usage = makeUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(estimateCost("claude-haiku-4-5", usage)).toBeCloseTo(6, 4);
    expect(estimateCost("claude-haiku-4-5-20251001", usage)).toBeCloseTo(6, 4);
  });

  test("prices Fable 5 and Mythos 5 at $10/$50", () => {
    const usage = makeUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(estimateCost("claude-fable-5", usage)).toBeCloseTo(60, 4);
    expect(estimateCost("claude-mythos-5", usage)).toBeCloseTo(60, 4);
  });

  test("prices Sonnet 4.6 at $3/$15", () => {
    const usage = makeUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(estimateCost("claude-sonnet-4-6", usage)).toBeCloseTo(18, 4);
  });

  test("returns null for an unknown future Anthropic model instead of mis-pricing it", () => {
    // No broad "claude-opus-4" catch-all: a model not in the table is honestly
    // unknown (null), not silently charged a neighbouring tier's price.
    expect(estimateCost("claude-opus-4-9", makeUsage({ inputTokens: 1_000_000 }))).toBeNull();
  });
});

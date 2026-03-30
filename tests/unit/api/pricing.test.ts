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
});

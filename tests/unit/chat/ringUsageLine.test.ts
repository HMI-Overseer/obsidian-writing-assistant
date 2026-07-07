import { describe, it, expect } from "vitest";
import { formatRingUsageLine } from "../../../src/chat/ContextCapacityUpdater";
import type { UsageTotals } from "../../../src/chat/usageSummary";

function totals(overrides: Partial<UsageTotals> = {}): UsageTotals {
  return {
    totalInputTokens: 800,
    totalOutputTokens: 400,
    totalCost: 0,
    hasUsage: true,
    ...overrides,
  };
}

describe("formatRingUsageLine", () => {
  it("returns null when the conversation carries no usage", () => {
    expect(formatRingUsageLine(totals({ hasUsage: false }), "anthropic")).toBeNull();
  });

  it("leads with cost for a metered provider that reported a price", () => {
    expect(formatRingUsageLine(totals({ totalCost: 0.05 }), "anthropic")).toBe(
      "$0.050 · 1.2k tokens"
    );
  });

  it("shows a subscription note, never a dollar figure, for Claude Code", () => {
    // Claude Code reports a real total_cost_usd, but it bills by subscription.
    const line = formatRingUsageLine(totals({ totalCost: 0.42 }), "claudecode");
    expect(line).toBe("Subscription · 1.2k tokens");
    expect(line).not.toContain("$");
  });

  it("shows only tokens for a free local model (LM Studio)", () => {
    expect(formatRingUsageLine(totals({ totalCost: 0 }), "lmstudio")).toBe("1.2k tokens");
  });

  it("suppresses a stray cost for a non-metered provider (mixed-provider guard)", () => {
    // A leftover aggregate cost must not surface while the active model is free.
    expect(formatRingUsageLine(totals({ totalCost: 0.03 }), "lmstudio")).toBe("1.2k tokens");
  });

  it("suppresses cost when the active provider is unknown", () => {
    expect(formatRingUsageLine(totals({ totalCost: 0.03 }), undefined)).toBe("1.2k tokens");
  });

  it("formats sub-cent cost to four decimals", () => {
    expect(formatRingUsageLine(totals({ totalCost: 0.0012 }), "openai")).toContain("$0.0012");
  });

  it("formats dollar-and-up cost to two decimals", () => {
    expect(formatRingUsageLine(totals({ totalCost: 2.5 }), "openai")).toContain("$2.50");
  });

  it("shows a bare token count below one thousand tokens", () => {
    expect(
      formatRingUsageLine(totals({ totalInputTokens: 300, totalOutputTokens: 100 }), "lmstudio")
    ).toBe("400 tokens");
  });
});

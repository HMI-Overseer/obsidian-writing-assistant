import { describe, it, expect } from "vitest";
import type { MessageUsage } from "../../../src/shared/types";
import {
  buildHeadline,
  describeCache,
  describeReplayFidelity,
  composeUsageTooltip,
} from "../../../src/chat/messages/UsageBadge";
import { PRICING_AS_OF } from "../../../src/api/pricing";

function usage(overrides: Partial<MessageUsage> = {}): MessageUsage {
  return { inputTokens: 12300, outputTokens: 456, ...overrides };
}

describe("buildHeadline", () => {
  it("uses cost as the headline for a metered provider with a known price", () => {
    expect(buildHeadline(usage({ estimatedCostUsd: 0.05 }), "anthropic")).toEqual({
      text: "~$0.050",
      isCost: true,
    });
  });

  it("falls back to total tokens for Claude Code (subscription, cost meaningless)", () => {
    // 12300 + 456 = 12756 → "12.8k".
    expect(buildHeadline(usage({ estimatedCostUsd: 0.05 }), "claudecode")).toEqual({
      text: "12.8k tok",
      isCost: false,
    });
  });

  it("falls back to total tokens for a metered model with no price", () => {
    expect(buildHeadline(usage(), "openai")).toEqual({ text: "12.8k tok", isCost: false });
  });

  it("shows total tokens for a free local model", () => {
    expect(buildHeadline(usage(), "lmstudio")).toEqual({ text: "12.8k tok", isCost: false });
  });
});

describe("describeReplayFidelity", () => {
  it.each([
    [
      "native Claude continuation",
      {
        tier: "native",
        capabilities: {
          captureOrder: "exact",
          toolCorrelation: "provider_id",
          coldReplay: "textual",
          nativeResume: true,
        },
      },
    ],
    [
      "structural direct replay",
      {
        tier: "structural",
        capabilities: {
          captureOrder: "exact",
          toolCorrelation: "provider_id",
          coldReplay: "structural",
          nativeResume: false,
        },
      },
    ],
    [
      "textual Claude rebuild",
      {
        tier: "textual",
        capabilities: {
          captureOrder: "exact",
          toolCorrelation: "provider_id",
          coldReplay: "textual",
          nativeResume: false,
        },
        loweredReason: "claude_code_structural_cold_replay_deferred",
      },
    ],
    [
      "degraded legacy capture",
      {
        tier: "textual",
        capabilities: {
          captureOrder: "segment",
          toolCorrelation: "none",
          coldReplay: "textual",
          nativeResume: false,
        },
        loweredReason: "claude_code_legacy_stream_json_capture",
      },
    ],
    [
      // An SDK turn can reach `segment` plus uncorrelated without ever touching
      // the legacy transport, so that pair must not be read as "legacy".
      "textual Claude rebuild",
      {
        tier: "textual",
        capabilities: {
          captureOrder: "segment",
          toolCorrelation: "none",
          coldReplay: "textual",
          nativeResume: false,
        },
        loweredReason: "claude_code_tool_correlation_missing",
      },
    ],
    [
      // Runtime placement composes its reason with whatever the provider already
      // reported (phase 4), so the label reads the list rather than one value.
      // Losing the second reason here would relabel a Claude turn "textual
      // replay", which is true but stops naming which provider it came from.
      "textual Claude rebuild",
      {
        tier: "textual",
        capabilities: {
          captureOrder: "segment",
          toolCorrelation: "provider_id",
          coldReplay: "textual",
          nativeResume: false,
        },
        loweredReason:
          "segment_placed_provider_item_present,claude_code_structural_cold_replay_deferred",
      },
    ],
    [
      "degraded legacy capture",
      {
        tier: "textual",
        capabilities: {
          captureOrder: "segment",
          toolCorrelation: "none",
          coldReplay: "textual",
          nativeResume: false,
        },
        loweredReason:
          "segment_placed_provider_item_present,claude_code_legacy_stream_json_capture",
      },
    ],
  ] as const)("labels %s", (expected, evidence) => {
    expect(describeReplayFidelity(evidence)).toBe(expected);
  });
});

describe("describeCache", () => {
  it("returns null when the provider reports no cache fields", () => {
    expect(describeCache(usage())).toBeNull();
  });

  it("surfaces read and write on a cache hit", () => {
    expect(
      describeCache(usage({ cacheReadInputTokens: 8100, cacheCreationInputTokens: 2000 })),
    ).toEqual({ text: "8.1k cache read · 2.0k cache write", state: "hit" });
  });

  it("omits the write figure when none was created", () => {
    expect(describeCache(usage({ cacheReadInputTokens: 8100 }))).toEqual({
      text: "8.1k cache read",
      state: "hit",
    });
  });

  it("flags a cache miss (0 read) as miss, still surfacing the write", () => {
    expect(
      describeCache(usage({ cacheReadInputTokens: 0, cacheCreationInputTokens: 2000 })),
    ).toEqual({ text: "0 cache read · 2.0k cache write", state: "miss" });
  });
});

describe("composeUsageTooltip", () => {
  it("gives the full Anthropic breakdown: in/out, cache, cost basis, model", () => {
    const tip = composeUsageTooltip(
      usage({ cacheReadInputTokens: 8100, cacheCreationInputTokens: 2000, estimatedCostUsd: 0.05 }),
      "claude-opus-4-8",
      "anthropic",
    );
    expect(tip).toBe(
      [
        "12,300 in · 456 out",
        "8,100 cache read · 2,000 cache write",
        `~$0.050, estimated, pricing as of ${PRICING_AS_OF}`,
        "model: claude-opus-4-8",
      ].join("\n"),
    );
  });

  it("omits the cache write figure when none was created", () => {
    const tip = composeUsageTooltip(usage({ cacheReadInputTokens: 0 }), "claude-opus-4-8", "anthropic");
    expect(tip).toContain("0 cache read");
    expect(tip).not.toContain("cache write");
  });

  it("notes the subscription and session line for Claude Code", () => {
    const tip = composeUsageTooltip(
      usage({ cacheReadInputTokens: 8100, sessionReused: false, sessionRebuildReason: "agentic-mode-changed" }),
      "claude-opus-4-8",
      "claudecode",
    );
    expect(tip).toContain("synthetic rebuild · agentic mode changed");
    expect(tip).toContain("Subscription (no per-message cost)");
    expect(tip).not.toContain("estimated, pricing as of");
  });

  it("shows only the in/out line for a free local model (no cost, no model)", () => {
    expect(composeUsageTooltip(usage(), "some-local-model", "lmstudio")).toBe("12,300 in · 456 out");
  });

  it("flags a metered model with no price entry", () => {
    const tip = composeUsageTooltip(usage(), "gpt-4o", "openai");
    expect(tip).toContain("Price unavailable, no local pricing for this model");
    expect(tip).toContain("model: gpt-4o");
  });
});

import { describe, test, expect } from "vitest";
import { sumConversationUsage } from "../../../src/chat/usageSummary";
import type { ConversationMessage, MessageUsage } from "../../../src/shared/types";

function makeMsg(
  role: "user" | "assistant",
  overrides: Partial<ConversationMessage> = {}
): ConversationMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    role,
    content: "test",
    ...overrides,
  };
}

function makeUsage(overrides: Partial<MessageUsage> = {}): MessageUsage {
  return {
    inputTokens: 100,
    outputTokens: 50,
    ...overrides,
  };
}

describe("sumConversationUsage", () => {
  test("returns zero totals for empty message list", () => {
    const result = sumConversationUsage([]);
    expect(result.hasUsage).toBe(false);
    expect(result.totalInputTokens).toBe(0);
    expect(result.totalOutputTokens).toBe(0);
    expect(result.totalCost).toBe(0);
  });

  test("returns zero totals when no messages have usage", () => {
    const messages = [
      makeMsg("user"),
      makeMsg("assistant"),
    ];
    const result = sumConversationUsage(messages);
    expect(result.hasUsage).toBe(false);
  });

  test("sums single message with usage", () => {
    const messages = [
      makeMsg("user"),
      makeMsg("assistant", {
        usage: makeUsage({ inputTokens: 200, outputTokens: 100, estimatedCostUsd: 0.005 }),
      }),
    ];
    const result = sumConversationUsage(messages);
    expect(result.hasUsage).toBe(true);
    expect(result.totalInputTokens).toBe(200);
    expect(result.totalOutputTokens).toBe(100);
    expect(result.totalCost).toBeCloseTo(0.005);
  });

  test("sums multiple messages with usage", () => {
    const messages = [
      makeMsg("user"),
      makeMsg("assistant", {
        usage: makeUsage({ inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.001 }),
      }),
      makeMsg("user"),
      makeMsg("assistant", {
        usage: makeUsage({ inputTokens: 200, outputTokens: 80, estimatedCostUsd: 0.003 }),
      }),
    ];
    const result = sumConversationUsage(messages);
    expect(result.totalInputTokens).toBe(300);
    expect(result.totalOutputTokens).toBe(130);
    expect(result.totalCost).toBeCloseTo(0.004);
  });

  test("sums ALL version costs for regenerated messages", () => {
    const messages = [
      makeMsg("user"),
      makeMsg("assistant", {
        versions: [
          { content: "v1", createdAt: 1000, usage: makeUsage({ inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.001 }) },
          { content: "v2", createdAt: 2000, usage: makeUsage({ inputTokens: 120, outputTokens: 60, estimatedCostUsd: 0.002 }) },
          { content: "v3", createdAt: 3000, usage: makeUsage({ inputTokens: 110, outputTokens: 55, estimatedCostUsd: 0.0015 }) },
        ],
        activeVersionIndex: 2,
        usage: makeUsage({ inputTokens: 110, outputTokens: 55, estimatedCostUsd: 0.0015 }),
      }),
    ];
    const result = sumConversationUsage(messages);
    // Should sum ALL three version costs, not just the active one
    expect(result.totalInputTokens).toBe(100 + 120 + 110);
    expect(result.totalOutputTokens).toBe(50 + 60 + 55);
    expect(result.totalCost).toBeCloseTo(0.001 + 0.002 + 0.0015);
  });

  test("handles versions where some lack usage", () => {
    const messages = [
      makeMsg("assistant", {
        versions: [
          { content: "v1", createdAt: 1000 },  // no usage (old version before tracking)
          { content: "v2", createdAt: 2000, usage: makeUsage({ inputTokens: 200, outputTokens: 80, estimatedCostUsd: 0.003 }) },
        ],
        activeVersionIndex: 1,
        usage: makeUsage({ inputTokens: 200, outputTokens: 80, estimatedCostUsd: 0.003 }),
      }),
    ];
    const result = sumConversationUsage(messages);
    expect(result.totalInputTokens).toBe(200);
    expect(result.totalOutputTokens).toBe(80);
    expect(result.totalCost).toBeCloseTo(0.003);
  });

  test("mixes versioned and non-versioned messages correctly", () => {
    const messages = [
      makeMsg("user"),
      makeMsg("assistant", {
        usage: makeUsage({ inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.001 }),
      }),
      makeMsg("user"),
      makeMsg("assistant", {
        versions: [
          { content: "v1", createdAt: 1000, usage: makeUsage({ inputTokens: 150, outputTokens: 70, estimatedCostUsd: 0.002 }) },
          { content: "v2", createdAt: 2000, usage: makeUsage({ inputTokens: 160, outputTokens: 75, estimatedCostUsd: 0.0025 }) },
        ],
        activeVersionIndex: 1,
        usage: makeUsage({ inputTokens: 160, outputTokens: 75, estimatedCostUsd: 0.0025 }),
      }),
    ];
    const result = sumConversationUsage(messages);
    // msg1: 100+50, msg2 versions: (150+70) + (160+75)
    expect(result.totalInputTokens).toBe(100 + 150 + 160);
    expect(result.totalOutputTokens).toBe(50 + 70 + 75);
    expect(result.totalCost).toBeCloseTo(0.001 + 0.002 + 0.0025);
  });

  test("excludes error messages without usage from totals", () => {
    const messages = [
      makeMsg("user"),
      makeMsg("assistant", {
        usage: makeUsage({ inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.001 }),
      }),
      makeMsg("user"),
      makeMsg("assistant", { isError: true, content: "Error: Rate limit exceeded" }),
    ];
    const result = sumConversationUsage(messages);
    expect(result.totalInputTokens).toBe(100);
    expect(result.totalOutputTokens).toBe(50);
    expect(result.totalCost).toBeCloseTo(0.001);
  });

  test("handles usage without estimatedCostUsd (LM Studio)", () => {
    const messages = [
      makeMsg("assistant", {
        usage: makeUsage({ inputTokens: 500, outputTokens: 200 }),
      }),
    ];
    const result = sumConversationUsage(messages);
    expect(result.hasUsage).toBe(true);
    expect(result.totalInputTokens).toBe(500);
    expect(result.totalOutputTokens).toBe(200);
    expect(result.totalCost).toBe(0);
  });
});

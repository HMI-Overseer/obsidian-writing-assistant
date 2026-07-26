import { describe, expect, test } from "vitest";
import { sumConversationUsage } from "../../../src/chat/usageSummary";
import type {
  ConversationMessage,
  MessageUsage,
} from "../../../src/shared/types";

function usage(
  inputTokens: number,
  outputTokens: number,
  estimatedCostUsd?: number,
): MessageUsage {
  return {
    inputTokens,
    outputTokens,
    ...(estimatedCostUsd === undefined
      ? {}
      : { estimatedCostUsd }),
  };
}

function assistant(
  usages: Array<MessageUsage | undefined>,
): ConversationMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    content: "Active.",
    revisions: usages.map((entry, index) => ({
      revisionId: `revision-${index}`,
      kind: "legacy",
      content: `Revision ${index}.`,
      ...(entry ? { usage: entry } : {}),
    })),
    activeRevisionId: `revision-${usages.length - 1}`,
    actionLedger: [],
  };
}

describe("sumConversationUsage", () => {
  test("returns zero totals when no immutable revision has usage", () => {
    expect(sumConversationUsage([])).toEqual({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      hasUsage: false,
    });
    expect(
      sumConversationUsage([
        { id: "user-1", role: "user", content: "Question" },
        assistant([undefined]),
      ]).hasUsage,
    ).toBe(false);
  });

  test("sums every immutable revision once", () => {
    const message = assistant([
      usage(100, 50, 0.001),
      usage(120, 60, 0.002),
      usage(110, 55, 0.0015),
    ]);
    message.versions = [
      {
        content: "stale duplicate",
        createdAt: 1,
        usage: usage(999, 999, 9),
      },
    ];
    message.usage = usage(110, 55, 0.0015);

    const result = sumConversationUsage([message]);
    expect(result).toMatchObject({
      totalInputTokens: 330,
      totalOutputTokens: 165,
      hasUsage: true,
    });
    expect(result.totalCost).toBeCloseTo(0.0045);
  });

  test("handles revisions without usage", () => {
    expect(
      sumConversationUsage([
        assistant([undefined, usage(200, 80, 0.003)]),
      ]),
    ).toMatchObject({
      totalInputTokens: 200,
      totalOutputTokens: 80,
      totalCost: 0.003,
      hasUsage: true,
    });
  });

  test("sums several assistant messages", () => {
    expect(
      sumConversationUsage([
        assistant([usage(100, 50, 0.001)]),
        {
          ...assistant([usage(200, 80, 0.003)]),
          id: "assistant-2",
        },
      ]),
    ).toMatchObject({
      totalInputTokens: 300,
      totalOutputTokens: 130,
      totalCost: 0.004,
    });
  });

  test("supports local-model usage without a price", () => {
    expect(
      sumConversationUsage([assistant([usage(500, 200)])]),
    ).toMatchObject({
      totalInputTokens: 500,
      totalOutputTokens: 200,
      totalCost: 0,
      hasUsage: true,
    });
  });
});

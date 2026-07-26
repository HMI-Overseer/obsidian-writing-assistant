import { describe, expect, it } from "vitest";
import type {
  AssistantToolCallItem,
  AssistantTurnRecord,
} from "../../../../src/shared/types";
import {
  INTERRUPTED_TOOL_RESULT_TEXT,
  allVisibleProse,
  deriveInterruptedToolResult,
  lastNonEmptyProse,
  rawConcatenatedProse,
  toolFactText,
} from "../../../../src/chat/turns/assistantTurnProjections";

function turnWithProse(texts: string[]): AssistantTurnRecord {
  return {
    schemaVersion: 1,
    id: "turn-projections",
    status: "completed",
    segments: [{ id: "segment-1" }],
    items: texts.map((text, index) => ({
      type: "prose",
      id: `prose-${index}`,
      segmentId: "segment-1",
      text,
    })),
  };
}

function tool(
  overrides: Partial<AssistantToolCallItem> = {},
): AssistantToolCallItem {
  return {
    type: "tool_call",
    id: "tool-item",
    segmentId: "segment-1",
    toolCallId: "call-1",
    toolName: "read_file",
    toolArguments: "{\"path\":\"Fixtures/a.md\"}",
    toolInput: "Fixtures/a.md",
    state: "completed",
    ...overrides,
  };
}

describe("assistant prose projections", () => {
  it("joins every visible prose item with one blank line", () => {
    const turn = turnWithProse(["First.", "Second.\n", "  Third.  "]);
    turn.items.splice(1, 0, tool());

    expect(allVisibleProse(turn)).toBe(
      "First.\n\nSecond.\n\n\n  Third.  ",
    );
  });

  it("concatenates exact streamed prose bytes without display separators", () => {
    const turn = turnWithProse(["\r\nA", "B\n\n", " C "]);
    turn.items.splice(1, 0, tool());

    expect(rawConcatenatedProse(turn)).toBe("\r\nAB\n\n C ");
  });

  it("returns the last non-empty prose bytes and null when none exist", () => {
    const turn = turnWithProse(["Earlier.", " \r\n ", "\nClosing.\n"]);

    expect(lastNonEmptyProse(turn)).toBe("\nClosing.\n");

    const toolOnly = turnWithProse([]);
    toolOnly.items.push(tool());
    expect(lastNonEmptyProse(toolOnly)).toBeNull();
    expect(lastNonEmptyProse(turnWithProse([" ", "\r\n"]))).toBeNull();
  });

  it("returns empty strings for empty or tool-only turns", () => {
    const empty = turnWithProse([]);
    const toolOnly = turnWithProse([]);
    toolOnly.items.push(tool());

    expect(allVisibleProse(empty)).toBe("");
    expect(rawConcatenatedProse(empty)).toBe("");
    expect(allVisibleProse(toolOnly)).toBe("");
    expect(rawConcatenatedProse(toolOnly)).toBe("");
  });
});

describe("assistant tool textual projections", () => {
  it("uses an existing bounded digest verbatim", () => {
    expect(
      toolFactText(
        tool({ resultDigest: "[read_file: Fixtures/a.md, synthetic digest]" }),
      ),
    ).toBe("[read_file: Fixtures/a.md, synthetic digest]");
  });

  it("projects completed, failed, and interrupted tool facts explicitly", () => {
    expect(toolFactText(tool())).toBe(
      "[read_file: Fixtures/a.md, completed]",
    );
    expect(
      toolFactText(
        tool({
          state: "failed",
          isError: true,
          errorContent: "Synthetic failure.",
        }),
      ),
    ).toBe("[read_file: Fixtures/a.md, FAILED: Synthetic failure.]");
    expect(toolFactText(tool({ state: "interrupted" }))).toBe(
      `[read_file: Fixtures/a.md, INTERRUPTED: ${INTERRUPTED_TOOL_RESULT_TEXT}]`,
    );
  });
});

describe("deriveInterruptedToolResult", () => {
  it("pairs the exact repair sentence with the interrupted tool-call ID", () => {
    expect(deriveInterruptedToolResult(tool({ state: "interrupted" }))).toEqual({
      toolCallId: "call-1",
      content: "Tool execution was interrupted before a result was produced.",
      isError: true,
    });
    expect(INTERRUPTED_TOOL_RESULT_TEXT).toBe(
      "Tool execution was interrupted before a result was produced.",
    );
  });

  it("rejects non-interrupted items", () => {
    expect(() => deriveInterruptedToolResult(tool())).toThrow(/not interrupted/i);
  });
});

import { describe, expect, it } from "vitest";
import {
  AssistantTurnBuilder,
  type AssistantTurnBuilderIdKind,
  type AssistantTurnSnapshot,
} from "../../../../src/chat/turns/AssistantTurnBuilder";
import {
  finishOrSalvageAssistantTurn,
  salvageAssistantTurn,
} from "../../../../src/chat/turns/assistantTurnSalvage";

function builder(turnId = "turn-1"): AssistantTurnBuilder {
  const counts: Record<AssistantTurnBuilderIdKind, number> = {
    segment: 0,
    item: 0,
  };
  return new AssistantTurnBuilder({
    turnId,
    createId: (kind) => `${kind}-${++counts[kind]}`,
  });
}

/** Prose, a sound tool call, a second tool call, prose: the shape of a real agentic turn. */
function agenticTurn(): AssistantTurnBuilder {
  const turn = builder();
  turn.startSegment({ segmentId: "segment-1" });
  turn.appendProseDelta("segment-1", "Before.", {
    providerBlockId: "block-0",
    deltaKey: "prose-0",
  });
  turn.startToolCall("segment-1", {
    declarationKey: "segment-1:0",
    providerBlockId: "block-1",
    toolCallId: "call-read",
    toolName: "read",
  });
  turn.appendToolArgumentsDelta("segment-1:0", "{\"path\":\"Fixtures/a.md\"}", {
    deltaKey: "args-0",
  });
  turn.startToolCall("segment-1", {
    declarationKey: "segment-1:1",
    providerBlockId: "block-2",
    toolCallId: "call-write",
    toolName: "write_file",
  });
  turn.appendToolArgumentsDelta(
    "segment-1:1",
    "{\"path\":\"Fixtures/b.md\",\"content\":\"synthetic\"}",
    { deltaKey: "args-1" },
  );
  turn.appendProseDelta("segment-1", "After.", {
    providerBlockId: "block-3",
    deltaKey: "prose-1",
  });
  turn.updateToolLifecycle("call-read", {
    state: "completed",
    resultRecord: "Synthetic read result.",
  });
  turn.updateToolLifecycle("call-write", {
    state: "completed",
    resultRecord: "Wrote Fixtures/b.md.",
  });
  return turn;
}

describe("finishOrSalvageAssistantTurn", () => {
  it("returns the finished record untouched when the turn is valid", () => {
    const turn = agenticTurn();

    const salvage = finishOrSalvageAssistantTurn(turn, "completed");

    expect(salvage.dropped).toEqual([]);
    expect(salvage.finishError).toBeUndefined();
    expect(salvage.turn.status).toBe("completed");
    expect(salvage.turn.items.map((item) => item.id)).toEqual([
      "item-1",
      "item-2",
      "item-3",
      "item-4",
    ]);
  });

  it("keeps every sound item and drops only the one validation refuses", () => {
    const turn = agenticTurn();
    // A field a future writer gets wrong. Nothing typed reaches this shape, so
    // the corruption is simulated through the lifecycle update.
    turn.updateToolLifecycle("call-write", {
      toolInput: 42 as unknown as string,
    });

    const salvage = finishOrSalvageAssistantTurn(turn, "failed");

    expect(salvage.finishError).toBeInstanceOf(Error);
    expect(salvage.dropped).toEqual([
      { code: "tool_input_invalid", path: "items[2].toolInput" },
    ]);
    expect(salvage.turn.status).toBe("failed");
    expect(salvage.turn.items).toMatchObject([
      { type: "prose", id: "item-1", text: "Before." },
      { type: "tool_call", id: "item-2", toolCallId: "call-read", state: "completed" },
      { type: "prose", id: "item-4", text: "After." },
    ]);
    expect(salvage.turn.segments).toEqual([{ id: "segment-1" }]);
  });
});

describe("salvageAssistantTurn", () => {
  function snapshot(): AssistantTurnSnapshot {
    return {
      schemaVersion: 1,
      id: "turn-1",
      status: "streaming",
      segments: [{ id: "segment-1" }, { id: "segment-2" }],
      items: [
        { type: "prose", id: "item-1", segmentId: "segment-1", text: "First." },
        { type: "prose", id: "item-2", segmentId: "segment-2", text: "Second." },
      ],
    };
  }

  it("drops a refused segment together with the items that belong to it", () => {
    const value = snapshot();
    value.segments[1] = { id: "segment-1" };
    value.items[1].segmentId = "segment-1";

    const salvage = salvageAssistantTurn(value, "interrupted");

    expect(salvage.dropped).toEqual([{ code: "id_duplicate", path: "segments[1].id" }]);
    expect(salvage.turn).toEqual({
      schemaVersion: 1,
      id: "turn-1",
      status: "interrupted",
      segments: [{ id: "segment-1" }],
      items: [
        { type: "prose", id: "item-1", segmentId: "segment-1", text: "First." },
        { type: "prose", id: "item-2", segmentId: "segment-1", text: "Second." },
      ],
    });
  });

  it("falls back to an empty record when the failure is not item or segment scoped", () => {
    const value = snapshot();
    value.id = "";

    const salvage = salvageAssistantTurn(value, "failed");

    expect(salvage.dropped).toEqual([{ code: "id_invalid", path: "id" }]);
    expect(salvage.turn).toEqual({
      schemaVersion: 1,
      id: "",
      status: "failed",
      segments: [],
      items: [],
    });
  });
});

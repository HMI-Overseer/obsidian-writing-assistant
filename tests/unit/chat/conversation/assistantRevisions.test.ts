import { describe, expect, it } from "vitest";
import {
  appendAssistantRevision,
  assistantDisplayText,
  assistantRawReplayText,
  copyTurnWithProvenance,
  createEditedRevision,
  createTurnRevision,
  getActiveAssistantRevision,
  replaceProseItemText,
  selectAssistantRevision,
  syncAssistantCompatibilityProjection,
} from "../../../../src/chat/conversation/assistantRevisions";
import type {
  AssistantTurnRecord,
  AssistantTurnRevision,
  ConversationMessage,
} from "../../../../src/shared/types";

function makeTurn(): AssistantTurnRecord {
  return {
    schemaVersion: 1,
    id: "turn-original",
    status: "completed",
    segments: [{ id: "segment-1" }],
    items: [
      {
        type: "prose",
        id: "prose-1",
        segmentId: "segment-1",
        text: "Before.",
      },
      {
        type: "tool_call",
        id: "tool-item-1",
        segmentId: "segment-1",
        toolCallId: "tool-call-1",
        toolName: "read_file",
        toolArguments: "{}",
        toolArgs: {},
        state: "completed",
        actionRef: "action-1",
      },
      {
        type: "prose",
        id: "prose-2",
        segmentId: "segment-1",
        text: "After.",
        actionRef: "parsed-action",
        actionAnchor: "parsed_edit",
      },
    ],
  };
}

function makeRevision(
  overrides: Partial<AssistantTurnRevision> = {},
): AssistantTurnRevision {
  return createTurnRevision({
    revisionId: "revision-1",
    origin: "generated",
    createdAt: 100,
    provider: "anthropic",
    modelId: "claude-fixture",
    turn: makeTurn(),
    usage: { inputTokens: 11, outputTokens: 7 },
    ragSources: [{ filePath: "Fixture.md", headingPath: "One", score: 0.8 }],
    rewrittenQuery: "rewritten fixture",
    isError: true,
    interrupted: true,
    errorMessage: "Generation stopped.",
    ...overrides,
  });
}

function makeMessage(
  revisions = [makeRevision()],
  activeRevisionId = revisions[0]?.revisionId,
): ConversationMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    content: "stale",
    revisions,
    activeRevisionId,
    actionLedger: [],
  };
}

describe("assistant revision selection and projections", () => {
  it("selects the active revision strictly by ID", () => {
    const message = makeMessage();

    expect(getActiveAssistantRevision(message)?.revisionId).toBe("revision-1");
    expect(
      getActiveAssistantRevision({ ...message, activeRevisionId: "missing" }),
    ).toBeNull();
  });

  it("switches the complete active revision and compatibility metadata", () => {
    const first = makeRevision();
    const second = makeRevision({
      revisionId: "revision-2",
      provider: "openai",
      modelId: "gpt-fixture",
      usage: { inputTokens: 21, outputTokens: 9 },
      ragSources: [{ filePath: "Other.md", headingPath: "", score: 0.6 }],
      rewrittenQuery: undefined,
      isError: undefined,
      interrupted: undefined,
      errorMessage: undefined,
      turn: {
        ...makeTurn(),
        id: "turn-second",
        items: [
          {
            type: "prose",
            id: "second-prose",
            segmentId: "segment-1",
            text: "Second revision.",
          },
        ],
      },
    });
    const message = syncAssistantCompatibilityProjection(
      makeMessage([first, second], first.revisionId),
    );

    const selected = selectAssistantRevision(message, second.revisionId);

    expect(selected).not.toBeNull();
    expect(selected?.activeRevisionId).toBe("revision-2");
    expect(selected?.content).toBe("Second revision.");
    expect(selected?.provider).toBe("openai");
    expect(selected?.modelId).toBe("gpt-fixture");
    expect(selected?.usage).toEqual({ inputTokens: 21, outputTokens: 9 });
    expect(selected?.ragSources?.[0]?.filePath).toBe("Other.md");
    expect(selected?.rewrittenQuery).toBeUndefined();
    expect(selected?.isError).toBeUndefined();
    expect(selected?.interrupted).toBeUndefined();
    expect(message.activeRevisionId).toBe(first.revisionId);
    expect(message.content).toBe("Before.\n\nAfter.");
  });

  it("derives display and raw replay text from the selected revision", () => {
    const message = makeMessage();

    expect(assistantDisplayText(message)).toBe("Before.\n\nAfter.");
    expect(assistantRawReplayText(message)).toBe("Before.After.");
  });
});

describe("assistant revision creation and immutable append", () => {
  it("creates generated and regenerated revisions with complete ownership", () => {
    const generated = makeRevision();
    const regenerated = createTurnRevision({
      revisionId: "revision-2",
      origin: "regenerated",
      parentRevisionId: generated.revisionId,
      createdAt: 200,
      provider: "openai",
      modelId: "gpt-fixture",
      turn: { ...makeTurn(), id: "turn-2" },
    });

    expect(generated.origin).toBe("generated");
    expect(regenerated.origin).toBe("regenerated");
    expect(regenerated.parentRevisionId).toBe("revision-1");
    expect(regenerated.createdAt).toBe(200);
    expect(regenerated.provider).toBe("openai");
  });

  it("appends without mutating prior revisions or duplicate top-level state", () => {
    const original = syncAssistantCompatibilityProjection(makeMessage());
    const before = structuredClone(original);
    const next = createTurnRevision({
      revisionId: "revision-2",
      origin: "regenerated",
      parentRevisionId: "revision-1",
      createdAt: 200,
      provider: "openai",
      modelId: "gpt-fixture",
      turn: {
        ...makeTurn(),
        id: "turn-2",
        items: [
          {
            type: "prose",
            id: "next-prose",
            segmentId: "segment-1",
            text: "Regenerated.",
          },
        ],
      },
    });

    const appended = appendAssistantRevision(original, next);

    expect(original).toEqual(before);
    expect(appended.revisions).toHaveLength(2);
    expect(appended.revisions?.[0]).toEqual(original.revisions?.[0]);
    expect(appended.revisions?.[0]).not.toBe(original.revisions?.[0]);
    expect(appended.activeRevisionId).toBe("revision-2");
    expect(appended.content).toBe("Regenerated.");
  });
});

describe("assistant edited revisions", () => {
  it("copies every item with new IDs and source provenance", () => {
    const copied = copyTurnWithProvenance(makeTurn(), {
      turnId: "turn-copy",
      itemId: (sourceId) => `copy-${sourceId}`,
    });

    expect(copied.id).toBe("turn-copy");
    expect(copied.items.map((item) => item.id)).toEqual([
      "copy-prose-1",
      "copy-tool-item-1",
      "copy-prose-2",
    ]);
    expect(copied.items.map((item) => item.sourceItemId)).toEqual([
      "prose-1",
      "tool-item-1",
      "prose-2",
    ]);
    expect(copied.items[1]).toMatchObject({
      type: "tool_call",
      toolCallId: "tool-call-1",
      actionRef: "action-1",
      state: "completed",
    });
    expect(copied.items[2]).toMatchObject({
      actionRef: "parsed-action",
      actionAnchor: "parsed_edit",
    });
  });

  it("replaces exactly one prose item without mutating its source turn", () => {
    const turn = makeTurn();
    const replaced = replaceProseItemText(turn, "prose-2", "Edited.");

    expect(replaced.items[2]).toMatchObject({ id: "prose-2", text: "Edited." });
    expect(turn.items[2]).toMatchObject({ id: "prose-2", text: "After." });
    expect(() => replaceProseItemText(turn, "tool-item-1", "No.")).toThrow(
      /prose item/i,
    );
    expect(() => replaceProseItemText(turn, "missing", "No.")).toThrow(
      /exactly one/i,
    );
  });

  it("creates an edited child revision with copy-on-write provenance", () => {
    const source = makeRevision();
    const edited = createEditedRevision({
      sourceRevision: source,
      revisionId: "revision-edited",
      turnId: "turn-edited",
      createdAt: 300,
      edits: [
        { sourceProseItemId: "prose-2", text: "Edited closing prose." },
      ],
      itemId: (sourceId) => `edited-${sourceId}`,
    });

    expect(edited.origin).toBe("edited");
    expect(edited.parentRevisionId).toBe(source.revisionId);
    expect(edited.provider).toBe(source.provider);
    expect(edited.modelId).toBe(source.modelId);
    expect(edited.usage).toEqual(source.usage);
    expect(edited.turn.items[2]).toMatchObject({
      id: "edited-prose-2",
      sourceItemId: "prose-2",
      text: "Edited closing prose.",
      actionRef: "parsed-action",
    });
    expect(source.turn.items[2]).toMatchObject({
      id: "prose-2",
      text: "After.",
    });
  });

  it("folds every prose item of one edit session into a single revision", () => {
    const source = makeRevision();
    const edited = createEditedRevision({
      sourceRevision: source,
      revisionId: "revision-edited",
      turnId: "turn-edited",
      createdAt: 300,
      edits: [
        { sourceProseItemId: "prose-1", text: "Edited opening prose." },
        { sourceProseItemId: "prose-2", text: "Edited closing prose." },
      ],
      itemId: (sourceId) => `edited-${sourceId}`,
    });

    expect(edited.turn.items.map((item) => item.id)).toEqual([
      "edited-prose-1",
      "edited-tool-item-1",
      "edited-prose-2",
    ]);
    expect(edited.turn.items.map((item) => item.sourceItemId)).toEqual([
      "prose-1",
      "tool-item-1",
      "prose-2",
    ]);
    expect(edited.turn.items[0]).toMatchObject({
      text: "Edited opening prose.",
    });
    expect(edited.turn.items[2]).toMatchObject({
      text: "Edited closing prose.",
    });
    expect(edited.turn.items[1]).toMatchObject({
      type: "tool_call",
      toolCallId: "tool-call-1",
      actionRef: "action-1",
    });
    expect(source.turn.items[0]).toMatchObject({ text: "Before." });
    expect(source.turn.items[2]).toMatchObject({ text: "After." });
  });

  it("refuses an empty session and a prose item edited twice", () => {
    const source = makeRevision();
    const input = {
      sourceRevision: source,
      revisionId: "revision-edited",
      turnId: "turn-edited",
      createdAt: 300,
      itemId: (sourceId: string) => `edited-${sourceId}`,
    };

    expect(() => createEditedRevision({ ...input, edits: [] })).toThrow(
      /at least one prose item/i,
    );
    expect(() =>
      createEditedRevision({
        ...input,
        edits: [
          { sourceProseItemId: "prose-2", text: "First." },
          { sourceProseItemId: "prose-2", text: "Second." },
        ],
      }),
    ).toThrow(/twice/i);
    expect(() =>
      createEditedRevision({
        ...input,
        edits: [{ sourceProseItemId: "tool-item-1", text: "No." }],
      }),
    ).toThrow(/prose item/i);
  });
});

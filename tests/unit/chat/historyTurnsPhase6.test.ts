import { describe, expect, it } from "vitest";
import {
  projectRequestHistoryTurns,
  toHistoryTurns,
} from "../../../src/chat/finalization/prepareApiMessages";
import { INTERRUPTED_TOOL_RESULT_TEXT } from "../../../src/chat/turns/assistantTurnProjections";
import type {
  AssistantToolCallItem,
  AssistantTurnRecord,
  ConversationMessage,
  ProviderOption,
} from "../../../src/shared/types";

function tool(
  id: string,
  segmentId: string,
  overrides: Partial<AssistantToolCallItem> = {},
): AssistantToolCallItem {
  return {
    type: "tool_call",
    id: `item-${id}`,
    segmentId,
    toolCallId: id,
    toolName: "read_file",
    toolArguments: `{"path":"${id}.md"}`,
    toolArgs: { path: `${id}.md` },
    state: "completed",
    resultRecord: `result for ${id}`,
    ...overrides,
  };
}

function assistantMessage(
  turn: AssistantTurnRecord,
  overrides: Partial<ConversationMessage> = {},
): ConversationMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    content: "stale compatibility prose",
    revisions: [
      {
        revisionId: "revision-1",
        kind: "turn",
        origin: "generated",
        createdAt: 1,
        provider: "anthropic",
        modelId: "claude-test",
        turn,
      },
    ],
    activeRevisionId: "revision-1",
    ...overrides,
  };
}

function project(
  messages: ConversationMessage[],
  provider: ProviderOption = "anthropic",
) {
  return projectRequestHistoryTurns(messages, false, provider);
}

describe("Phase 6 history expansion", () => {
  it("keeps a user message one-to-one", () => {
    const message: ConversationMessage = {
      id: "user-1",
      role: "user",
      content: "Hello.",
    };

    expect(toHistoryTurns(message, false, "anthropic")).toEqual([
      { role: "user", content: "Hello." },
    ]);
  });

  it("expands one selected turn revision by segment and keeps same-segment calls together", () => {
    const turn: AssistantTurnRecord = {
      schemaVersion: 1,
      id: "turn-1",
      status: "completed",
      segments: [{ id: "s1" }, { id: "s2" }, { id: "s3" }],
      items: [
        { type: "prose", id: "p1", segmentId: "s1", text: "Before." },
        tool("call-1", "s1"),
        tool("call-2", "s2"),
        tool("call-3", "s2"),
        { type: "prose", id: "p2", segmentId: "s3", text: "After." },
      ],
    };

    const turns = toHistoryTurns(
      assistantMessage(turn),
      false,
      "anthropic",
    );

    expect(turns.map((historyTurn) => historyTurn.role)).toEqual([
      "assistant",
      "tool",
      "assistant",
      "tool",
      "tool",
      "assistant",
    ]);
    expect(turns[0].assistantContent).toEqual([
      { type: "prose", text: "Before." },
      {
        type: "tool_call",
        toolCallId: "call-1",
        toolName: "read_file",
        toolArguments: '{"path":"call-1.md"}',
        toolArgs: { path: "call-1.md" },
      },
    ]);
    expect(turns[2].assistantContent?.filter((item) => item.type === "tool_call"))
      .toHaveLength(2);
    expect(turns[3].toolCallId).toBe("call-2");
    expect(turns[4].toolCallId).toBe("call-3");
    expect(turns[5].assistantContent).toEqual([
      { type: "prose", text: "After." },
    ]);
  });

  it("keeps calls from separate silent segments in distinct assistant/result cycles", () => {
    const message = assistantMessage({
      schemaVersion: 1,
      id: "turn-silent",
      status: "completed",
      segments: [{ id: "s1" }, { id: "s2" }],
      items: [tool("call-1", "s1"), tool("call-2", "s2")],
    });

    const turns = toHistoryTurns(message, false, "openai");

    expect(turns.map((turn) => [turn.role, turn.toolCallId])).toEqual([
      ["assistant", undefined],
      ["tool", "call-1"],
      ["assistant", undefined],
      ["tool", "call-2"],
    ]);
  });

  it("pairs successful, failed, and interrupted results by toolCallId", () => {
    const message = assistantMessage({
      schemaVersion: 1,
      id: "turn-results",
      status: "interrupted",
      segments: [{ id: "s1" }],
      items: [
        tool("success", "s1"),
        tool("failed", "s1", {
          state: "failed",
          resultRecord: "permission denied",
          isError: true,
          errorContent: "permission denied",
        }),
        tool("interrupted", "s1", {
          state: "running",
          resultRecord: undefined,
        }),
      ],
    });

    const results = toHistoryTurns(message, false, "anthropic").slice(1);

    expect(results).toEqual([
      {
        role: "tool",
        content: "result for success",
        toolCallId: "success",
      },
      {
        role: "tool",
        content: "permission denied",
        toolCallId: "failed",
        toolResultIsError: true,
      },
      {
        role: "tool",
        content: INTERRUPTED_TOOL_RESULT_TEXT,
        toolCallId: "interrupted",
        toolResultIsError: true,
      },
    ]);
  });

  it("does not invent prose for tool-only or empty turns", () => {
    const toolOnly = assistantMessage({
      schemaVersion: 1,
      id: "turn-tool-only",
      status: "completed",
      segments: [{ id: "s1" }],
      items: [tool("call-1", "s1")],
    });
    const empty = assistantMessage({
      schemaVersion: 1,
      id: "turn-empty",
      status: "completed",
      segments: [],
      items: [],
    });

    expect(toHistoryTurns(toolOnly, false, "openai")[0]).toMatchObject({
      role: "assistant",
      content: null,
    });
    expect(toHistoryTurns(empty, false, "openai")).toEqual([]);
  });
});

describe("Phase 6 replay fidelity lowering", () => {
  it.each([
    {
      name: "invalid identity",
      change: { toolCallId: "" },
      reason: "tool_call_id_invalid",
    },
    {
      name: "malformed arguments",
      change: { toolArguments: '{"path":', toolArgs: undefined },
      reason: "tool_arguments_invalid",
    },
    {
      name: "missing result evidence",
      change: { resultRecord: undefined, resultDigest: undefined },
      reason: "tool_result_evidence_missing",
    },
  ])("lowers $name to textual replay", ({ change, reason }) => {
    const invalidTool = tool("call-1", "s1", change);
    const message = assistantMessage({
      schemaVersion: 1,
      id: "turn-invalid",
      status: "completed",
      segments: [{ id: "s1" }],
      items: [
        { type: "prose", id: "p1", segmentId: "s1", text: "Visible prose." },
        invalidTool,
      ],
    });

    const result = project([message], "lmstudio");

    expect(result.replayEvidence.tier).toBe("textual");
    expect(result.replayEvidence.loweredReason).toContain(reason);
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0].assistantContent).toBeUndefined();
    expect(result.turns[0].content).toContain("Visible prose.");
  });

  it("accepts a complete bounded Anthropic capsule and rejects an invalid capsule whole", () => {
    const validMessage = assistantMessage({
      schemaVersion: 1,
      id: "turn-capsule",
      status: "completed",
      segments: [
        {
          id: "s1",
          replayCapsule: {
            provider: "anthropic",
            version: 1,
            thinkingBlocks: [
              {
                type: "thinking",
                thinking: "private",
                signature: "signature-1",
              },
            ],
          },
        },
      ],
      items: [tool("call-1", "s1")],
    });
    const valid = project([validMessage], "anthropic");
    expect(valid.replayEvidence.tier).toBe("structural");
    expect(valid.turns[0].providerReplayCapsule).toEqual(
      validMessage.revisions?.[0].kind === "turn"
        ? validMessage.revisions[0].turn.segments[0].replayCapsule
        : null,
    );

    const invalidMessage = structuredClone(validMessage);
    const revision = invalidMessage.revisions?.[0];
    if (revision?.kind !== "turn") throw new Error("Fixture revision missing.");
    revision.turn.segments[0].replayCapsule = {
      provider: "anthropic",
      version: 1,
      thinkingBlocks: [
        { type: "thinking", thinking: "private", signature: "" },
      ],
    };
    const invalid = project([invalidMessage], "anthropic");
    expect(invalid.replayEvidence.tier).toBe("textual");
    expect(invalid.replayEvidence.loweredReason).toContain(
      "replay_capsule_invalid",
    );
    expect(invalid.turns[0].providerReplayCapsule).toBeUndefined();
  });

  it("keeps legacy direct history byte-compatible and textual", () => {
    const message: ConversationMessage = {
      id: "legacy-1",
      role: "assistant",
      content: "  Legacy bytes.\r\n\r\nTrailing.  ",
    };

    const result = project([message], "openai");

    expect(result.turns).toEqual([
      { role: "assistant", content: message.content },
    ]);
    expect(result.replayEvidence.tier).toBe("textual");
  });

  it("preserves selected ask guidance on an error without duplicating structural results", () => {
    const ask = tool("ask-1", "s1", {
      toolName: "ask_user",
      toolArguments: '{"questions":[]}',
      toolArgs: { questions: [] },
      resultRecord: '{"answers":{"Format":"Detailed"}}',
      resultDigest: "[stale display digest]",
      askStatus: "completed",
      askGuidance: {
        questions: [
          {
            question: "Format",
            header: "Output",
            answer: "Detailed",
          },
        ],
      },
    });
    const message = assistantMessage(
      {
        schemaVersion: 1,
        id: "turn-error-ask",
        status: "failed",
        segments: [{ id: "s1" }],
        items: [ask],
      },
      { isError: true },
    );

    const result = project([message], "anthropic");
    const serialized = JSON.stringify(result.turns);
    const guidance =
      '[ask_user guidance: {"questions":[{"question":"Format","header":"Output","answer":"Detailed"}]}]';

    expect(result.turns).toEqual([
      { role: "assistant", content: guidance },
    ]);
    expect(serialized.split("ask_user guidance")).toHaveLength(2);
    expect(serialized).not.toContain("stale display digest");
    expect(result.turns.some((turn) => turn.role === "tool")).toBe(false);
  });

  it("excludes unplaced action audit wording from structural, textual, and raw replay", () => {
    const auditText = "SAFETY AUDIT: auto-applied secret wording";
    const message = assistantMessage(
      {
        schemaVersion: 1,
        id: "turn-audit",
        status: "completed",
        segments: [{ id: "s1" }],
        items: [
          { type: "prose", id: "p1", segmentId: "s1", text: "Visible." },
          tool("call-1", "s1"),
        ],
      },
      {
        actionLedger: [
          {
            actionRef: "unplaced-action",
            revisionId: "revision-1",
            family: "memory",
            placement: {
              state: "unplaced",
              correlation: {
                kind: "provider_id",
                toolCallId: "missing-declaration",
              },
              reason: "declaration_missing",
            },
            payload: {
              targets: [
                {
                  targetId: "target-1",
                  mutation: {
                    kind: "add",
                    memory: {
                      id: "memory-1",
                      name: auditText,
                      content: auditText,
                      createdAt: 1,
                      updatedAt: 1,
                    },
                  },
                },
              ],
            },
            events: [
              {
                eventId: "event-1",
                type: "apply_succeeded",
                targetId: "target-1",
                createdAt: 1,
                effect: {
                  family: "memory",
                  before: null,
                  after: {
                    id: "memory-1",
                    name: auditText,
                    content: auditText,
                    createdAt: 1,
                    updatedAt: 1,
                  },
                  appliedAt: 1,
                },
              },
            ],
          },
        ],
      },
    );

    const structural = project([message], "anthropic");
    const textual = project([message], "claudecode");
    const serialized = JSON.stringify({
      structural: structural.turns,
      textual: textual.turns,
    });

    expect(serialized).not.toContain(auditText);
    expect(textual.turns[0].rawContent).toBe("Visible.");
  });
});

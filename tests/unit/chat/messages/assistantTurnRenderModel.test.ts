import { describe, expect, it } from "vitest";
import type {
  AssistantTurnRecord,
  ConversationMessage,
} from "../../../../src/shared/types";
import {
  buildAssistantTurnRenderModel,
  buildLegacyAssistantRenderModel,
  planAssistantTurnKeyedUpdate,
  selectAssistantMessageRenderSource,
} from "../../../../src/chat/messages/assistantTurnRenderModel";

function prose(id: string, segmentId: string, text: string) {
  return {
    type: "prose" as const,
    id,
    segmentId,
    text,
  };
}

function tool(
  id: string,
  segmentId: string,
  toolCallId: string,
  state: "declared" | "running" | "completed" | "interrupted" | "failed" = "completed",
) {
  return {
    type: "tool_call" as const,
    id,
    segmentId,
    toolCallId,
    toolName: "read_file",
    toolArguments: `{"path":"${id}.md"}`,
    toolArgs: { path: `${id}.md` },
    toolInput: `${id}.md`,
    state,
  };
}

function turn(
  status: AssistantTurnRecord["status"],
  items: AssistantTurnRecord["items"],
  segments = [...new Set(items.map((item) => item.segmentId))],
): AssistantTurnRecord {
  return {
    schemaVersion: 1,
    id: "turn-1",
    status,
    segments: segments.map((id) => ({ id })),
    items,
  };
}

describe("assistant turn render model", () => {
  it("preserves exact interleaved prose and tool declaration order", () => {
    const source = turn("completed", [
      prose("p1", "s1", "First"),
      tool("t1", "s1", "call-1"),
      prose("p2", "s1", "Second"),
      tool("t2", "s1", "call-2"),
      prose("p3", "s1", "Final"),
    ]);

    const model = buildAssistantTurnRenderModel(source);

    expect(model.items.map((item) => [item.id, item.type])).toEqual([
      ["p1", "prose"],
      ["t1", "tool_call"],
      ["p2", "prose"],
      ["t2", "tool_call"],
      ["p3", "prose"],
    ]);
    expect(model.items.map((item) => item.marker)).toEqual([
      "thinking",
      "tool",
      "thinking",
      "tool",
      "none",
    ]);
    expect(model.items.map((item) => item.connector)).toEqual([
      { before: true, after: true },
      { before: true, after: true },
      { before: true, after: true },
      { before: true, after: true },
      { before: true, after: false },
    ]);
    expect(
      model.items.map((item) => item.fadeIncomingConnector),
    ).toEqual([false, false, false, false, true]);
  });

  it("derives live placeholders without persisting a prose classification", () => {
    const streaming = buildAssistantTurnRenderModel(
      turn("streaming", [prose("p1", "s1", "Streaming")]),
    );
    const settled = buildAssistantTurnRenderModel(
      turn("streaming", [
        prose("p1", "s1", "Streaming"),
        tool("t1", "s1", "call-1", "running"),
      ]),
    );
    const completed = buildAssistantTurnRenderModel(
      turn("completed", [prose("p1", "s1", "Streaming")]),
    );

    expect(streaming.items[0].marker).toBe("streaming");
    expect(settled.items[0].marker).toBe("thinking");
    expect(completed.items[0].marker).toBe("none");
    expect(streaming.items[0].fadeIncomingConnector).toBe(false);
    expect(settled.items[1].fadeIncomingConnector).toBe(false);
    expect(completed.items[0].fadeIncomingConnector).toBe(true);
    expect(sourceItemKeys(streaming.items[0])).not.toContain("reasoning");
    expect(sourceItemKeys(streaming.items[0])).not.toContain("answer");
    expect(sourceItemKeys(streaming.items[0])).not.toContain("final");
  });

  it("does not fade an interrupted prose endpoint", () => {
    const model = buildAssistantTurnRenderModel(
      turn("interrupted", [prose("p1", "s1", "Partial response")]),
    );

    expect(model.items[0].marker).toBe("none");
    expect(model.items[0].fadeIncomingConnector).toBe(false);
  });

  it("covers completed, running, failed, and interrupted tool lifecycle text", () => {
    const model = buildAssistantTurnRenderModel(
      turn("interrupted", [
        tool("done", "s1", "call-done", "completed"),
        tool("running", "s1", "call-running", "running"),
        {
          ...tool("failed", "s2", "call-failed", "failed"),
          isError: true,
          errorContent: "Permission denied",
        },
        tool("stopped", "s2", "call-stopped", "interrupted"),
      ]),
    );

    expect(model.items.map((item) => item.accessibleState)).toEqual([
      "Completed",
      "Running",
      "Failed",
      "Interrupted",
    ]);
    expect(model.notice).toEqual({
      kind: "interrupted",
      label: "Generation stopped.",
    });
  });

  it("keeps prose-only, tool-only, and empty turns honest", () => {
    const proseOnly = buildAssistantTurnRenderModel(
      turn("completed", [prose("p1", "s1", "Only prose")]),
    );
    const toolOnly = buildAssistantTurnRenderModel(
      turn("completed", [tool("t1", "s1", "call-1")]),
    );
    const streamingEmpty = buildAssistantTurnRenderModel(turn("streaming", []));
    const completedEmpty = buildAssistantTurnRenderModel(turn("completed", []));
    const interruptedEmpty = buildAssistantTurnRenderModel(turn("interrupted", []));
    const failedEmpty = buildAssistantTurnRenderModel(turn("failed", []));

    expect(proseOnly.items[0].marker).toBe("none");
    expect(proseOnly.emptyState).toBeNull();
    expect(toolOnly.items.map((item) => item.type)).toEqual(["tool_call"]);
    expect(toolOnly.emptyState).toBeNull();
    expect(streamingEmpty.emptyState?.kind).toBe("streaming");
    expect(streamingEmpty.emptyState?.announce).toBe(false);
    expect(completedEmpty.emptyState?.label).toBe("No response.");
    expect(interruptedEmpty.emptyState?.label).toBe("Generation stopped.");
    expect(failedEmpty.emptyState?.label).toBe("Generation failed.");
  });

  it("preserves multiple segments and same-segment mutation batches without visual splits", () => {
    const model = buildAssistantTurnRenderModel(
      turn(
        "completed",
        [
          tool("write-1", "s1", "call-1"),
          tool("write-2", "s1", "call-2"),
          tool("read-3", "s2", "call-3"),
          prose("p1", "s3", "Done"),
        ],
        ["s1", "s2", "s3"],
      ),
    );

    expect(model.items.map((item) => item.segmentId)).toEqual([
      "s1",
      "s1",
      "s2",
      "s3",
    ]);
    expect(model.items.every((item) => !("segmentSeparator" in item))).toBe(true);
  });

  it("selects the frozen active turn revision on reload and ignores stale top-level truth", () => {
    const frozen = turn("completed", [
      prose("p1", "s1", "Before"),
      tool("t1", "s1", "call-1"),
      prose("p2", "s2", "After"),
    ]);
    const message: ConversationMessage = {
      id: "message-1",
      role: "assistant",
      content: "stale flattened body",
      revisions: [
        {
          revisionId: "revision-1",
          kind: "turn",
          origin: "generated",
          createdAt: 1,
          provider: "openai",
          modelId: "test-model",
          turn: frozen,
        },
      ],
      activeRevisionId: "revision-1",
      actionLedger: [],
      agenticSteps: [
        { type: "reasoning", round: 0, text: "stale detached reasoning" },
      ],
    };

    const selected = selectAssistantMessageRenderSource(message);

    expect(selected.kind).toBe("turn");
    if (selected.kind !== "turn") throw new Error("Expected turn source.");
    expect(selected.turn).toBe(frozen);
    expect(buildAssistantTurnRenderModel(selected.turn).items.map((item) => item.id)).toEqual([
      "p1",
      "t1",
      "p2",
    ]);
  });

  it("falls back conservatively to legacy steps followed by one iconless content item", () => {
    const model = buildLegacyAssistantRenderModel({
      key: "message-legacy:revision-legacy",
      status: "completed",
      content: "Legacy final prose",
      steps: [
        { type: "reasoning", round: 0, text: "Legacy visible step" },
        {
          type: "tool_call",
          round: 0,
          toolName: "read_file",
          toolCallId: "legacy-call",
          toolInput: "Legacy.md",
        },
      ],
    });

    expect(model.items.map((item) => [item.type, item.id])).toEqual([
      ["prose", "legacy:message-legacy:revision-legacy:step:0"],
      ["tool_call", "legacy:message-legacy:revision-legacy:step:1"],
      ["prose", "legacy:message-legacy:revision-legacy:content"],
    ]);
    expect(model.items.at(-1)?.marker).toBe("none");
  });

  it("does not duplicate a legacy error sentinel as prose and a failed notice", () => {
    const selected = selectAssistantMessageRenderSource({
      id: "legacy-error",
      role: "assistant",
      content: "Error: Connection closed",
      isError: true,
    });

    expect(selected.kind).toBe("legacy");
    if (selected.kind !== "legacy") throw new Error("Expected legacy source.");
    expect(selected.source.content).toBe("");
    expect(
      buildLegacyAssistantRenderModel(selected.source),
    ).toMatchObject({
      items: [],
      emptyState: {
        kind: "failed",
        label: "Error: Connection closed",
      },
    });
  });

  it("plans keyed live updates without duplicate item hosts", () => {
    const plan = planAssistantTurnKeyedUpdate(
      ["p1", "t1"],
      ["p1", "t1", "p2"],
    );

    expect(plan).toEqual({
      order: ["p1", "t1", "p2"],
      reused: ["p1", "t1"],
      added: ["p2"],
      removed: [],
    });
    expect(new Set(plan.order).size).toBe(plan.order.length);
  });

  it("does not mutate a frozen turn while deriving display state", () => {
    const source = Object.freeze(
      turn("failed", [
        Object.freeze(prose("p1", "s1", "Visible")),
        Object.freeze({
          ...tool("t1", "s1", "call-1", "failed"),
          isError: true,
          errorContent: "No access",
        }),
      ]),
    );
    const before = structuredClone(source);

    buildAssistantTurnRenderModel(source);

    expect(source).toEqual(before);
  });

  it("preserves HTML-looking prose, arguments, and errors only as display text", () => {
    const html = '<img src=x onerror="fixture()"> <script>fixture()</script>';
    const model = buildAssistantTurnRenderModel(
      turn("failed", [
        prose("p1", "s1", html),
        {
          ...tool("t1", "s1", "call-1", "failed"),
          toolArguments: JSON.stringify({ value: html }),
          toolArgs: { value: html },
          errorContent: html,
          isError: true,
        },
      ]),
    );

    expect(model.items[0]).toMatchObject({ type: "prose", text: html });
    expect(model.items[1]).toMatchObject({
      type: "tool_call",
      toolArguments: JSON.stringify({ value: html }),
      toolArgs: { value: html },
      errorContent: html,
    });
  });

  it("summarizes what a call operated on instead of showing its raw arguments", () => {
    const model = buildAssistantTurnRenderModel(
      turn("completed", [
        {
          ...tool("t1", "s1", "call-1"),
          toolName: "list_directory",
          toolArguments: '{"path":"Books"}',
          toolArgs: { path: "Books" },
          toolInput: undefined,
        },
        {
          ...tool("t2", "s1", "call-2"),
          toolName: "search_content",
          toolArguments: "",
          toolArgs: undefined,
          toolInput: '{"query":"prequel"}',
        },
        {
          ...tool("t3", "s1", "call-3"),
          toolName: "list_directory",
          toolArguments: "",
          toolArgs: undefined,
          toolInput: "{}",
        },
      ]),
    );

    expect(
      model.items.map((item) =>
        item.type === "tool_call" ? item.toolInput : null,
      ),
    ).toEqual(["Books", "prequel", undefined]);
  });

  it("recovers arguments a lifecycle capture recorded as a JSON input blob", () => {
    const model = buildAssistantTurnRenderModel(
      turn("completed", [
        {
          ...tool("t1", "s1", "call-1"),
          toolArguments: "",
          toolArgs: undefined,
          toolInput: '{"path":"Books/Overview.md"}',
        },
      ]),
    );

    expect(model.items[0]).toMatchObject({
      type: "tool_call",
      toolArgs: { path: "Books/Overview.md" },
      toolInput: "Books/Overview.md",
      hasDisclosure: true,
    });
  });
});

function sourceItemKeys(value: object): string[] {
  return Object.keys(value);
}

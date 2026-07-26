import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AssistantStreamEvent } from "../../../../src/api/usageTypes";
import {
  ClaudeCodeSdkMessageTranslator,
} from "../../../../src/api/sdk/claudeCodeSdkMessageTranslator";
import { extractClaudeCodeToolUseId } from "../../../../src/api/sdk/sdkMcpServer";

interface FixtureSequenceEntry {
  source: string;
  message?: unknown;
  extra?: unknown;
}

interface ClaudeCodeFixture {
  toolUseId?: string;
  sequence: FixtureSequenceEntry[];
}

function fixture(name: string): ClaudeCodeFixture {
  return JSON.parse(
    readFileSync(
      join(
        process.cwd(),
        "tests",
        "fixtures",
        "assistant-turns",
        name,
      ),
      "utf8",
    ),
  ) as ClaudeCodeFixture;
}

function translator(
  toolCorrelation: "provider_id" | "none" = "provider_id",
): ClaudeCodeSdkMessageTranslator {
  return new ClaudeCodeSdkMessageTranslator({
    createSegmentId: (index) => `segment-sdk-${index}`,
    toolCorrelation,
  });
}

function sdkMessages(input: ClaudeCodeFixture): unknown[] {
  return input.sequence
    .filter((entry) => entry.source === "sdk" && entry.message !== undefined)
    .map((entry) => entry.message);
}

function translateAll(
  instance: ClaudeCodeSdkMessageTranslator,
  messages: readonly unknown[],
): AssistantStreamEvent[] {
  return messages.flatMap((message) => instance.translate(message));
}

describe("ClaudeCodeSdkMessageTranslator", () => {
  it("keeps all four probed tool-use ID surfaces exact and translates terminal results", () => {
    const input = fixture("claude-code-sdk-correlated.json");
    const messages = sdkMessages(input);
    const terminal = {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      session_id: "session-fixture",
      usage: { input_tokens: 10, output_tokens: 2 },
    };
    const events = translateAll(translator(), [...messages, terminal]);
    const expectedId = input.toolUseId;

    const partialId = events.find(
      (event) => event.type === "tool_call_identity",
    );
    const completedId = events
      .filter((event) => event.type === "segment_reconcile")
      .flatMap((event) => event.blocks)
      .find((block) => block.type === "tool_call");
    const resultId = events.find((event) => event.type === "tool_result");
    const handlerExtra = input.sequence.find(
      (entry) => entry.source === "handler",
    )?.extra;

    expect(partialId).toMatchObject({ toolCallId: expectedId });
    expect(completedId).toMatchObject({ toolCallId: expectedId });
    expect(resultId).toMatchObject({ toolCallId: expectedId });
    expect(extractClaudeCodeToolUseId(handlerExtra)).toBe(expectedId);
    expect(events.at(-1)).toEqual({
      type: "turn_end",
      status: "completed",
    });
  });

  it("preserves text, tool_use, mcp_tool_use, input deltas, stops, and completed order", () => {
    const instance = translator();
    const messages = [
      {
        type: "stream_event",
        parent_tool_use_id: null,
        uuid: "partial-text-start",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      },
      {
        type: "stream_event",
        parent_tool_use_id: null,
        uuid: "partial-text-delta",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Inspecting. " },
        },
      },
      {
        type: "stream_event",
        parent_tool_use_id: null,
        uuid: "partial-text-stop",
        event: { type: "content_block_stop", index: 0 },
      },
      {
        type: "stream_event",
        parent_tool_use_id: null,
        uuid: "partial-tool-start",
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "toolu_native_1",
            name: "native_fixture",
            input: {},
          },
        },
      },
      {
        type: "stream_event",
        parent_tool_use_id: null,
        uuid: "partial-tool-delta",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json: "{\"value\":1}",
          },
        },
      },
      {
        type: "stream_event",
        parent_tool_use_id: null,
        uuid: "partial-tool-stop",
        event: { type: "content_block_stop", index: 1 },
      },
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          id: "message-ordered",
          role: "assistant",
          content: [
            { type: "text", text: "Inspecting. " },
            {
              type: "tool_use",
              id: "toolu_native_1",
              name: "native_fixture",
              input: { value: 1 },
            },
            { type: "text", text: "Done." },
            {
              type: "mcp_tool_use",
              id: "toolu_mcp_2",
              name: "mcp__writing_assistant__read_file",
              server_name: "writing_assistant",
              input: { path: "Fixtures/ordered.md" },
            },
          ],
        },
      },
    ];

    const events = translateAll(instance, messages);
    const reconcile = events.find(
      (event) => event.type === "segment_reconcile",
    );

    expect(events).toContainEqual({
      type: "prose_delta",
      segmentId: "segment-sdk-0",
      providerBlockId: "block-0",
      deltaKey: "partial-text-delta",
      delta: "Inspecting. ",
    });
    expect(events).toContainEqual({
      type: "tool_call_delta",
      declarationKey: "segment-sdk-0:block-1",
      deltaKey: "partial-tool-delta",
      argumentsDelta: "{\"value\":1}",
    });
    expect(reconcile).toMatchObject({
      type: "segment_reconcile",
      segmentId: "segment-sdk-0",
      providerMessageId: "message-ordered",
      blocks: [
        { type: "prose", text: "Inspecting. " },
        {
          type: "tool_call",
          toolCallId: "toolu_native_1",
          toolName: "native_fixture",
        },
        { type: "prose", text: "Done." },
        {
          type: "tool_call",
          toolCallId: "toolu_mcp_2",
          toolName: "read_file",
        },
      ],
    });
    expect(events.filter((event) => event.type === "segment_end")).toEqual([
      { type: "segment_end", segmentId: "segment-sdk-0" },
    ]);
  });

  it("buffers a lifecycle race through exact identity and reconciles missing partial prose", () => {
    const input = fixture(
      "claude-code-sdk-lifecycle-before-declaration.json",
    );
    const events = translateAll(translator(), sdkMessages(input));
    const reconcile = events.find(
      (event) => event.type === "segment_reconcile",
    );

    expect(events).toContainEqual({
      type: "tool_call_delta",
      declarationKey: "segment-sdk-0:block-1",
      argumentsDelta: "{\"path\":\"Fixtures/race.md\"}",
    });
    expect(reconcile).toMatchObject({
      blocks: [
        { type: "prose", text: "I will inspect the fixture." },
        {
          type: "tool_call",
          toolCallId: "toolu_fixture_race_1",
          toolName: "read_file",
        },
      ],
    });
  });

  it("excludes subagent messages and reconciles duplicate partial and completed facts idempotently", () => {
    const instance = translator();
    const partial = {
      type: "stream_event",
      parent_tool_use_id: null,
      uuid: "partial-once",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Once." },
      },
    };
    const completed = {
      type: "assistant",
      parent_tool_use_id: null,
      uuid: "completed-once",
      message: {
        id: "message-once",
        role: "assistant",
        content: [{ type: "text", text: "Once." }],
      },
    };
    const subagent = {
      type: "assistant",
      parent_tool_use_id: "toolu_parent",
      uuid: "subagent-message",
      message: {
        id: "message-subagent",
        role: "assistant",
        content: [{ type: "text", text: "Do not include." }],
      },
    };

    const events = translateAll(instance, [
      partial,
      partial,
      subagent,
      completed,
      structuredClone(completed),
    ]);

    expect(
      events.filter((event) => event.type === "prose_delta"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "segment_reconcile"),
    ).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("Do not include.");
    expect(instance.rawText()).toBe("Once.");
  });

  it("keeps legacy structured activity ordered but explicitly uncorrelated", () => {
    const input = fixture(
      "claude-code-legacy-stream-json-uncorrelated.json",
    );
    const events = translateAll(
      translator("none"),
      sdkMessages({
        ...input,
        sequence: input.sequence.map((entry) =>
          entry.source === "stdout"
            ? { ...entry, source: "sdk" }
            : entry,
        ),
      }),
    );

    expect(events).toContainEqual({
      type: "tool_call_identity",
      declarationKey: "segment-sdk-0:block-1",
      toolCallId: "toolu_fixture_legacy_visible_1",
      correlation: "none",
    });
    expect(events).toContainEqual({
      type: "tool_result",
      toolCallId: "toolu_fixture_legacy_visible_1",
      content: "synthetic result",
      isError: false,
    });
    expect(JSON.stringify(events)).not.toContain('"id":7');
  });
});

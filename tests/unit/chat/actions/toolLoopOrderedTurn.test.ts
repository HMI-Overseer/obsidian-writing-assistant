import { describe, expect, it, vi } from "vitest";
import type { ChatClient } from "../../../../src/api/chatClient";
import type {
  AssistantStreamEvent,
  StreamResult,
} from "../../../../src/api/usageTypes";
import type { ChatRequest } from "../../../../src/shared/chatRequest";
import type {
  AssistantReplayEvidence,
  SamplingParams,
} from "../../../../src/shared/types";
import { runToolLoop } from "../../../../src/chat/actions/toolLoop";
import { AssistantTurnBuilder } from "../../../../src/chat/turns/AssistantTurnBuilder";
import { THINK_TOOL_NAME } from "../../../../src/tools/think/definition";
import type { ToolLoopCallbacks } from "../../../../src/chat/actions/toolLoop";

const EVIDENCE: AssistantReplayEvidence = {
  tier: "structural",
  capabilities: {
    captureOrder: "exact",
    toolCorrelation: "provider_id",
    coldReplay: "structural",
    nativeResume: false,
  },
};

function streamResult(events: AssistantStreamEvent[]): StreamResult {
  return {
    events: (async function* () {
      yield* events;
    })(),
    usage: Promise.resolve(null),
    stopReason: Promise.resolve(
      events.some((event) => event.type === "tool_call_start")
        ? "tool_use"
        : "end_turn",
    ),
    replayCapsule: Promise.resolve(null),
    replayEvidence: Promise.resolve(EVIDENCE),
  };
}

function segment(
  segmentId: string,
  body: AssistantStreamEvent[],
): AssistantStreamEvent[] {
  return [
    { type: "segment_start", segmentId },
    ...body,
    { type: "segment_end", segmentId },
    { type: "turn_end", status: "completed" },
  ];
}

function tool(
  segmentId: string,
  index: number,
  id: string,
  name: string,
): AssistantStreamEvent[] {
  const declarationKey = `${segmentId}:tool:${index}`;
  return [
    {
      type: "tool_call_start",
      segmentId,
      declarationKey,
      toolName: name,
    },
    {
      type: "tool_call_identity",
      declarationKey,
      toolCallId: id,
      correlation: "provider_id",
    },
    {
      type: "tool_call_delta",
      declarationKey,
      argumentsDelta: "{}",
    },
  ];
}

function makeClient(
  rounds: AssistantStreamEvent[][],
  seenRequests: ChatRequest[] = [],
): ChatClient {
  let index = 0;
  return {
    complete: vi.fn(),
    stream: (request: ChatRequest) => {
      seenRequests.push(structuredClone(request));
      const events = rounds[index];
      index += 1;
      if (!events) throw new Error("Unexpected provider round.");
      return streamResult(events);
    },
  } as unknown as ChatClient;
}

function callbacks(): ToolLoopCallbacks {
  return {
    onDelta: vi.fn(),
    onNewRound: vi.fn(),
    onStepRecorded: vi.fn(),
    onStepResult: vi.fn(),
  };
}

const baseRequest = {
  systemPrompt: "",
  documentContext: null,
  ragContext: null,
  messages: [],
} as ChatRequest;

async function run(
  rounds: AssistantStreamEvent[][],
  seenRequests: ChatRequest[] = [],
  request: ChatRequest = baseRequest,
) {
  return runToolLoop(
    makeClient(rounds, seenRequests),
    request,
    "test-model",
    "openai",
    {} as SamplingParams,
    new AbortController().signal,
    callbacks(),
    5,
    true,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    new AssistantTurnBuilder({
      turnId: "turn-phase3",
      createId: (() => {
        let next = 0;
        return (kind) => `${kind}-${next++}`;
      })(),
    }),
  );
}

describe("runToolLoop ordered turn capture", () => {
  it("persists prose after a declaration at its observed position", async () => {
    const first = "segment-first";
    const final = "segment-final";
    const result = await run([
      segment(first, [
        {
          type: "prose_delta",
          segmentId: first,
          delta: "Before.",
        },
        ...tool(first, 0, "call-think", THINK_TOOL_NAME),
        {
          type: "prose_delta",
          segmentId: first,
          delta: "After declaration.",
        },
      ]),
      segment(final, [
        {
          type: "prose_delta",
          segmentId: final,
          delta: "Final.",
        },
      ]),
    ]);

    expect(result.turn.items.map((item) =>
      item.type === "prose" ? item.text : item.toolCallId
    )).toEqual([
      "Before.",
      "call-think",
      "After declaration.",
      "Final.",
    ]);
    expect(result.turn.items[1]).toMatchObject({
      type: "tool_call",
      state: "completed",
      segmentId: first,
    });
  });

  it("keeps one provider mutation batch in one assistant history emission", async () => {
    const batch = "segment-batch";
    const final = "segment-final";
    const seenRequests: ChatRequest[] = [];
    const result = await run([
      segment(batch, [
        ...tool(batch, 0, "call-a", "custom_write_a"),
        ...tool(batch, 1, "call-b", "custom_write_b"),
        ...tool(batch, 2, "call-c", "custom_write_c"),
      ]),
      segment(final, [
        {
          type: "prose_delta",
          segmentId: final,
          delta: "Done.",
        },
      ]),
    ], seenRequests);

    const batchItems = result.turn.items.filter(
      (item) => item.segmentId === batch && item.type === "tool_call",
    );
    expect(batchItems).toHaveLength(3);
    expect(batchItems.map((item) => item.toolCallId)).toEqual([
      "call-a",
      "call-b",
      "call-c",
    ]);

    const replayedAssistants = seenRequests[1].messages.filter(
      (turn) => turn.role === "assistant",
    );
    expect(replayedAssistants).toHaveLength(1);
    expect(
      replayedAssistants[0].assistantContent?.flatMap((item) =>
        item.type === "tool_call" ? [item.toolCallId] : [],
      ),
    ).toEqual(["call-a", "call-b", "call-c"]);
    const replayedResults = seenRequests[1].messages.filter(
      (turn) => turn.role === "tool",
    );
    expect(replayedResults.map((turn) => turn.toolCallId)).toEqual([
      "call-a",
      "call-b",
      "call-c",
    ]);
  });

  it("persists the request history's actual textual tier in diagnostics", async () => {
    const request: ChatRequest = {
      ...baseRequest,
      replayEvidence: {
        tier: "textual",
        capabilities: {
          captureOrder: "text_only",
          toolCorrelation: "none",
          coldReplay: "textual",
          nativeResume: false,
        },
        loweredReason: "legacy_assistant_textual_replay",
      },
    };
    const result = await run(
      [
        segment("segment-final", [
          {
            type: "prose_delta",
            segmentId: "segment-final",
            delta: "Done.",
          },
        ]),
      ],
      [],
      request,
    );

    expect(result.replayEvidence).toEqual(request.replayEvidence);
  });
});

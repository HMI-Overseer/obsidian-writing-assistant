import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { ChatClient } from "../../../../src/api/chatClient";
import { createAbortError } from "../../../../src/api/httpTransport";
import type { AssistantStreamEvent } from "../../../../src/api/usageTypes";
import type { AssistantStreamRun } from "../../../../src/api/assistantStreamRun";
import { ownedRunFromLegacy } from "../../../helpers/ownedRun";
import {
  planAskBarrierBatch,
  runToolLoop,
  type ToolLoopCallbacks,
} from "../../../../src/chat/actions/toolLoop";
import {
  AskInteractionPreconditionError,
  AskInteractionValidationError,
} from "../../../../src/chat/interactions/AskInteractionCoordinator";
import type { ChatRequest } from "../../../../src/shared/chatRequest";
import type { AskAnswers, AskUserResponder } from "../../../../src/tools/ask/types";
import type { ToolCall } from "../../../../src/tools/types";

interface RoundScript {
  deltas: string[];
  toolCalls: ToolCall[] | null;
  stopReason: string;
}

const question = "Which output shape should I optimize for?";
const askArguments = {
  questions: [
    {
      question,
      header: "Output",
      options: [
        { label: "Concise", description: "Focus on the recommendation." },
        { label: "Detailed", description: "Include rationale and examples." },
      ],
      multiSelect: false,
    },
  ],
};

function call(id: string, name: string, arguments_: Record<string, unknown> = {}): ToolCall {
  return { id, name, arguments: arguments_ };
}

function client(rounds: RoundScript[]): ChatClient & { stream: ReturnType<typeof vi.fn> } {
  let index = 0;
  const stream = vi.fn(
    (request: ChatRequest): AssistantStreamRun<AssistantStreamEvent> => {
    const roundIndex = index++;
    const round = rounds[roundIndex];
    const segmentId = `segment-${roundIndex}`;
    const events = (async function* (): AsyncGenerator<AssistantStreamEvent> {
      yield { type: "segment_start", segmentId };
      for (const delta of round.deltas) {
        yield { type: "prose_delta", segmentId, delta };
      }
      for (let toolIndex = 0; toolIndex < (round.toolCalls?.length ?? 0); toolIndex += 1) {
        const toolCall = round.toolCalls?.[toolIndex];
        if (!toolCall) continue;
        const declarationKey = `${segmentId}-tool-${toolIndex}`;
        yield {
          type: "tool_call_start",
          segmentId,
          declarationKey,
          toolName: toolCall.name,
        };
        yield {
          type: "tool_call_delta",
          declarationKey,
          argumentsDelta: JSON.stringify(toolCall.arguments),
        };
        yield {
          type: "tool_call_identity",
          declarationKey,
          toolCallId: toolCall.id,
          correlation: "provider_id",
        };
      }
      yield { type: "segment_end", segmentId };
      yield {
        type: "turn_end",
        stopReason: round.stopReason as never,
      };
    })();
    return ownedRunFromLegacy({
      events,
      usage: Promise.resolve(null),
      stopReason: Promise.resolve(round.stopReason as never),
      replayCapsule: Promise.resolve(null),
      replayEvidence: Promise.resolve({
        tier: "structural",
        capabilities: {
          captureOrder: "exact",
          toolCorrelation: "provider_id",
          coldReplay: "structural",
          nativeResume: false,
        },
      }),
    });
  });
  return { complete: vi.fn(), stream } as unknown as ChatClient & {
    stream: ReturnType<typeof vi.fn>;
  };
}

function callbacks(): ToolLoopCallbacks & {
  onStepRecorded: ReturnType<typeof vi.fn>;
} {
  return {
    onDelta: vi.fn(),
    onToolStatus: vi.fn(),
    onStepRecorded: vi.fn(),
    onNewRound: vi.fn(),
  };
}

function responder(
  ask: AskUserResponder["ask"],
): AskUserResponder & { ask: ReturnType<typeof vi.fn> } {
  return {
    ask: vi.fn(ask),
    cancelPending: vi.fn(),
  };
}

function run(
  scriptedClient: ChatClient,
  cb: ToolLoopCallbacks,
  askResponder: AskUserResponder,
  maxRounds = 5,
  signal = new AbortController().signal,
  contexts?: {
    vault?: Parameters<typeof runToolLoop>[9];
    edit?: Parameters<typeof runToolLoop>[10];
    vaultOp?: Parameters<typeof runToolLoop>[11];
    memory?: Parameters<typeof runToolLoop>[12];
  },
) {
  return runToolLoop(
    scriptedClient,
    { messages: [], allowedToolNames: ["ask_user"] } as unknown as ChatRequest,
    "test-model",
    "lmstudio",
    {} as never,
    signal,
    cb,
    maxRounds,
    true,
    contexts?.vault,
    contexts?.edit,
    contexts?.vaultOp,
    contexts?.memory,
    askResponder,
  );
}

describe("planAskBarrierBatch", () => {
  it.each([
    ["first", ["ask_user", "read", "write_file"]],
    ["middle", ["read", "ask_user", "write_file"]],
    ["last", ["read", "write_file", "ask_user"]],
  ])("finds the primary ask when it is %s", (_label, names) => {
    const calls = names.map((name, index) =>
      call(String(index), name, name === "ask_user" ? askArguments : {}),
    );
    const plan = planAskBarrierBatch(calls);

    expect(plan?.primaryAsk.name).toBe("ask_user");
    expect(plan?.blockedSiblings.map((toolCall) => toolCall.name)).toEqual(
      names.filter((name) => name !== "ask_user"),
    );
  });

  it("keeps later ask calls separate from ordinary siblings", () => {
    const plan = planAskBarrierBatch([
      call("a1", "ask_user", askArguments),
      call("r1", "read"),
      call("a2", "ask_user", askArguments),
    ]);

    expect(plan?.primaryAsk.id).toBe("a1");
    expect(plan?.laterAsks.map((toolCall) => toolCall.id)).toEqual(["a2"]);
    expect(plan?.blockedSiblings.map((toolCall) => toolCall.id)).toEqual(["r1"]);
  });

  it("returns null when the batch contains no ask", () => {
    expect(planAskBarrierBatch([call("r1", "read")])).toBeNull();
  });
});

describe("runToolLoop ask_user barrier", () => {
  it("settles every sibling before waiting, blocks the next stream, and resumes with exact JSON", async () => {
    let submit!: (answers: AskAnswers) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const ask = responder(
      () =>
        new Promise<AskAnswers>((resolve) => {
          submit = resolve;
          markStarted();
        }),
    );
    const cb = callbacks();
    const app = {
      vault: {
        adapter: {},
        getName: () => "Vault",
        getAbstractFileByPath: vi.fn(() => null),
        getRoot: () => null,
      },
    } as unknown as App;
    const availability = vi.fn(() => "ready");
    const retrieve = vi.fn(async () => []);
    const resolveRound = vi.fn(async () => []);
    const resolveEdits = vi.fn(async () => []);
    const resolveMemories = vi.fn(async () => []);
    const scriptedClient = client([
      {
        deltas: ["I need your guidance."],
        toolCalls: [
          call("read-1", "semantic_search", { query: "a" }),
          call("ask-1", "ask_user", askArguments),
          call("edit-1", "edit", { path: "a.md" }),
          call("op-1", "write_file", { path: "b.md", content: "x" }),
          call("memory-1", "add_memory", { name: "x" }),
          call("unknown-1", "unknown_tool"),
        ],
        stopReason: "tool_use",
      },
      { deltas: ["Done."], toolCalls: null, stopReason: "end_turn" },
    ]);

    const pending = run(
      scriptedClient,
      cb,
      ask,
      5,
      new AbortController().signal,
      {
        vault: {
          app,
          ragService: { availability, retrieve } as never,
        },
        edit: { app, filePath: "a.md" },
        vaultOp: {
          app,
          liveReview: {
            resolveRound,
            resolveEdits,
            resolveMemories,
          } as never,
        },
        memory: {
          memoryService: {} as never,
          getMemories: () => [],
          saveSettings: async () => undefined,
        },
      },
    );
    await started;

    expect(scriptedClient.stream).toHaveBeenCalledTimes(1);
    expect(cb.onToolStatus).not.toHaveBeenCalled();
    expect(availability).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
    expect(resolveRound).not.toHaveBeenCalled();
    expect(resolveEdits).not.toHaveBeenCalled();
    expect(resolveMemories).not.toHaveBeenCalled();
    const beforeSubmit = cb.onStepRecorded.mock.calls.map((args) => args[0].toolCallId);
    expect(beforeSubmit).toEqual(["read-1", "edit-1", "op-1", "memory-1", "unknown-1"]);

    submit({ [question]: "Detailed" });
    const result = await pending;

    expect(result.writeToolCalls).toBeNull();
    expect(availability).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
    expect(resolveRound).not.toHaveBeenCalled();
    expect(resolveEdits).not.toHaveBeenCalled();
    expect(resolveMemories).not.toHaveBeenCalled();
    expect(scriptedClient.stream).toHaveBeenCalledTimes(2);
    const secondRequest = scriptedClient.stream.mock.calls[1][0] as ChatRequest;
    const toolTurns = secondRequest.messages.filter((turn) => turn.role === "tool");
    expect(toolTurns.map((turn) => turn.toolCallId)).toEqual([
      "read-1",
      "ask-1",
      "edit-1",
      "op-1",
      "memory-1",
      "unknown-1",
    ]);
    expect(toolTurns[1].content).toBe(
      JSON.stringify({ answers: { [question]: "Detailed" } }),
    );
    expect(cb.onStepRecorded).toHaveBeenCalledTimes(6);
  });

  it("returns invalid arguments without mounting or executing siblings", async () => {
    const ask = responder(() =>
      Promise.reject(
        new AskInteractionValidationError({
          ok: false,
          code: "questions_count",
          message: "questions must contain between 1 and 4 entries.",
        }),
      ),
    );
    const cb = callbacks();
    const scriptedClient = client([
      {
        deltas: [],
        toolCalls: [
          call("ask-invalid", "ask_user", { questions: [] }),
          call("read-skipped", "read", { path: "a.md" }),
        ],
        stopReason: "tool_use",
      },
      { deltas: ["Recovered."], toolCalls: null, stopReason: "end_turn" },
    ]);

    await run(scriptedClient, cb, ask);

    const secondRequest = scriptedClient.stream.mock.calls[1][0] as ChatRequest;
    const results = secondRequest.messages.filter((turn) => turn.role === "tool");
    expect(results[0].content).toContain("questions_count");
    expect(results[1].content).toContain("ask_sibling_skipped");
    expect(cb.onToolStatus).not.toHaveBeenCalled();
  });

  it("executes only the first ask and returns a correction for later asks", async () => {
    const ask = responder(async () => ({ [question]: "Concise" }));
    const scriptedClient = client([
      {
        deltas: [],
        toolCalls: [
          call("ask-1", "ask_user", askArguments),
          call("ask-2", "ask_user", askArguments),
        ],
        stopReason: "tool_use",
      },
      { deltas: ["Done."], toolCalls: null, stopReason: "end_turn" },
    ]);

    await run(scriptedClient, callbacks(), ask);

    expect(ask.ask).toHaveBeenCalledTimes(1);
    const secondRequest = scriptedClient.stream.mock.calls[1][0] as ChatRequest;
    const results = secondRequest.messages.filter((turn) => turn.role === "tool");
    expect(results.map((turn) => turn.toolCallId)).toEqual(["ask-1", "ask-2"]);
    expect(results[1].content).toContain("ask_repeated");
  });

  it("translates a concurrent coordinator refusal", async () => {
    const ask = responder(() => Promise.reject(new AskInteractionPreconditionError()));
    const scriptedClient = client([
      {
        deltas: [],
        toolCalls: [call("ask-1", "ask_user", askArguments)],
        stopReason: "tool_use",
      },
      { deltas: ["Recovered."], toolCalls: null, stopReason: "end_turn" },
    ]);

    await run(scriptedClient, callbacks(), ask);

    const secondRequest = scriptedClient.stream.mock.calls[1][0] as ChatRequest;
    const result = secondRequest.messages.find((turn) => turn.role === "tool");
    expect(result?.content).toContain("ask_concurrent");
  });

  it("records cancellation before rethrowing AbortError", async () => {
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const ask = responder((_request, context) => {
      markStarted();
      return new Promise<AskAnswers>((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(createAbortError()), {
          once: true,
        });
      });
    });
    const cb = callbacks();
    const pending = run(
      client([
        {
          deltas: [],
          toolCalls: [call("ask-1", "ask_user", askArguments)],
          stopReason: "tool_use",
        },
      ]),
      cb,
      ask,
      5,
      controller.signal,
    );
    await started;

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cb.onStepRecorded).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: "ask-1",
        askStatus: "cancelled",
        isError: true,
      }),
    );
  });

  it("answers an ask at the round cap, then allows one synthesis pass", async () => {
    const ask = responder(async () => ({ [question]: "Detailed" }));
    const scriptedClient = client([
      {
        deltas: ["round zero"],
        toolCalls: [call("think-1", "think")],
        stopReason: "tool_use",
      },
      {
        deltas: ["cap ask"],
        toolCalls: [call("ask-cap", "ask_user", askArguments)],
        stopReason: "tool_use",
      },
      { deltas: ["Synthesis."], toolCalls: null, stopReason: "end_turn" },
    ]);

    await run(scriptedClient, callbacks(), ask, 1);

    expect(ask.ask).toHaveBeenCalledTimes(1);
    expect(scriptedClient.stream).toHaveBeenCalledTimes(3);
    const synthesisRequest = scriptedClient.stream.mock.calls[2][0] as ChatRequest;
    expect(
      synthesisRequest.messages.find((turn) => turn.toolCallId === "ask-cap")?.content,
    ).toBe(JSON.stringify({ answers: { [question]: "Detailed" } }));
  });

  it("hard-stops if the synthesis pass calls another tool after a cap-boundary ask", async () => {
    const ask = responder(async () => ({ [question]: "Detailed" }));
    const scriptedClient = client([
      {
        deltas: ["round zero"],
        toolCalls: [call("think-1", "think")],
        stopReason: "tool_use",
      },
      {
        deltas: ["cap ask"],
        toolCalls: [call("ask-cap", "ask_user", askArguments)],
        stopReason: "tool_use",
      },
      {
        deltas: ["still calling"],
        toolCalls: [call("think-2", "think")],
        stopReason: "tool_use",
      },
    ]);

    await run(scriptedClient, callbacks(), ask, 1);

    expect(ask.ask).toHaveBeenCalledTimes(1);
    expect(scriptedClient.stream).toHaveBeenCalledTimes(3);
  });
});

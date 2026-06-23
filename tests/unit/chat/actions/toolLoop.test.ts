import { describe, it, expect, vi } from "vitest";
import type { App } from "obsidian";
import { runToolLoop } from "../../../../src/chat/actions/toolLoop";
import type { ToolLoopCallbacks } from "../../../../src/chat/actions/toolLoop";
import type { ChatClient } from "../../../../src/api/chatClient";
import type { StreamResult } from "../../../../src/api/usageTypes";
import type { ChatRequest } from "../../../../src/shared/chatRequest";
import type { ToolCall } from "../../../../src/tools/types";
import { THINK_TOOL_NAME } from "../../../../src/tools/think/definition";
import { EDIT_TOOL_NAMES } from "../../../../src/tools/editing/definition";
import type { LiveVaultReview } from "../../../../src/chat/actions/liveVaultReview";

/**
 * Answer-track prose accumulation.
 *
 * Prose that narrates a mutating action (a write/edit/vault-op call) is part of
 * the user-facing answer, e.g. "Here's the file I created: ```…```", and must
 * reach the bubble via onDelta, not be stranded as a plain-text reasoning step
 * in the timeline. Prose that merely precedes a read-only tool stays reasoning.
 * These tests pin that routing so the regression can't return in either mode.
 */

interface RoundScript {
  deltas: string[];
  toolCalls: ToolCall[] | null;
  stopReason: string;
}

function makeClient(rounds: RoundScript[]): ChatClient {
  let i = 0;
  return {
    complete: vi.fn(),
    stream: (): StreamResult => {
      const round = rounds[i++];
      const deltas = (async function* () {
        for (const d of round.deltas) yield d;
      })();
      return {
        deltas,
        usage: Promise.resolve(null),
        toolCalls: Promise.resolve(round.toolCalls),
        stopReason: Promise.resolve(round.stopReason),
      } as unknown as StreamResult;
    },
  } as unknown as ChatClient;
}

function makeCallbacks(): ToolLoopCallbacks & {
  onDelta: ReturnType<typeof vi.fn>;
  onReasoningRoundFinished: ReturnType<typeof vi.fn>;
} {
  return {
    onDelta: vi.fn(),
    onReasoningDelta: vi.fn(),
    onReasoningRoundFinished: vi.fn(),
    onNewRound: vi.fn(),
    onStepRecorded: vi.fn(),
  };
}

const call = (name: string): ToolCall => ({ id: `${name}-1`, name, arguments: {} });

const baseRequest = { messages: [] } as unknown as ChatRequest;

function run(rounds: RoundScript[], callbacks: ToolLoopCallbacks) {
  return runToolLoop(
    makeClient(rounds),
    baseRequest,
    "test-model",
    "lmstudio",
    {} as never,
    new AbortController().signal,
    callbacks,
    5, // maxRounds, high enough to never cap
    true, // agenticMode
  );
}

/** The text from a single onDelta flush (the loop delivers the answer in one shot). */
function flushedAnswer(cb: ReturnType<typeof makeCallbacks>): string {
  expect(cb.onDelta).toHaveBeenCalledTimes(1);
  return cb.onDelta.mock.calls[0][0];
}

describe("runToolLoop answer-track prose", () => {
  it("delivers prose that narrated a mutating action even with an empty final round", async () => {
    const cb = makeCallbacks();
    await run(
      [
        { deltas: ["Created it: ```md\n# Hi\n```"], toolCalls: [call("custom_write")], stopReason: "tool_use" },
        { deltas: [], toolCalls: null, stopReason: "end_turn" },
      ],
      cb,
    );

    expect(flushedAnswer(cb)).toBe("Created it: ```md\n# Hi\n```");
    // The mutating round's prose must NOT be committed as reasoning.
    expect(cb.onReasoningRoundFinished).toHaveBeenCalledWith(false, 0);
  });

  it("joins mutating-round narration with a final wrap-up message", async () => {
    const cb = makeCallbacks();
    await run(
      [
        { deltas: ["Creating the file: ```md\n# Hi\n```"], toolCalls: [call("custom_write")], stopReason: "tool_use" },
        { deltas: ["Done, the file is ready."], toolCalls: null, stopReason: "end_turn" },
      ],
      cb,
    );

    expect(flushedAnswer(cb)).toBe("Creating the file: ```md\n# Hi\n```\n\nDone, the file is ready.");
  });

  it("keeps prose that precedes a read-only tool as reasoning, not answer", async () => {
    const cb = makeCallbacks();
    await run(
      [
        { deltas: ["Let me think about this"], toolCalls: [call(THINK_TOOL_NAME)], stopReason: "tool_use" },
        { deltas: ["Here is the answer."], toolCalls: null, stopReason: "end_turn" },
      ],
      cb,
    );

    // Only the final answer reaches the bubble; the think-round prose is committed
    // as reasoning instead.
    expect(flushedAnswer(cb)).toBe("Here is the answer.");
    expect(cb.onReasoningRoundFinished).toHaveBeenCalledWith(true, 0);
  });
});

/** A client that records how many times the model was streamed. */
function countingClient(rounds: RoundScript[]): ChatClient & { stream: ReturnType<typeof vi.fn> } {
  let i = 0;
  const stream = vi.fn((): StreamResult => {
    const round = rounds[i++];
    const deltas = (async function* () {
      for (const d of round.deltas) yield d;
    })();
    return {
      deltas,
      usage: Promise.resolve(null),
      toolCalls: Promise.resolve(round.toolCalls),
      stopReason: Promise.resolve(round.stopReason),
    } as unknown as StreamResult;
  });
  return { complete: vi.fn(), stream } as unknown as ChatClient & {
    stream: ReturnType<typeof vi.fn>;
  };
}

const signal = () => new AbortController().signal;

describe("runToolLoop round cap", () => {
  it("injects one synthesis pass when the cap is hit, then ends without re-executing tools", async () => {
    const cb = makeCallbacks();
    const client = countingClient([
      { deltas: ["look 0"], toolCalls: [call(THINK_TOOL_NAME)], stopReason: "tool_use" }, // round 0
      { deltas: ["look 1"], toolCalls: [call(THINK_TOOL_NAME)], stopReason: "tool_use" }, // round 1: cap
      { deltas: ["Here is what I found."], toolCalls: null, stopReason: "end_turn" }, // round 2: synthesis
    ]);

    await runToolLoop(
      client,
      baseRequest,
      "test-model",
      "lmstudio",
      {} as never,
      signal(),
      cb,
      1, // maxRounds
      true, // agenticMode
    );

    expect(client.stream).toHaveBeenCalledTimes(3); // round 0, capped round 1, synthesis round 2
    // The capped round's tool is replaced by a terminal result, never executed, so
    // only round 0's think tool records a step.
    expect(cb.onStepRecorded).toHaveBeenCalledTimes(1);
    expect(flushedAnswer(cb)).toBe("Here is what I found.");
  });

  it("hard-stops when the model keeps calling tools after the cap warning", async () => {
    const cb = makeCallbacks();
    // No fourth round is scripted: if the loop failed to hard-stop it would read
    // past the script and throw, so a clean return proves the hard stop.
    const client = countingClient([
      { deltas: ["look 0"], toolCalls: [call(THINK_TOOL_NAME)], stopReason: "tool_use" }, // round 0
      { deltas: ["look 1"], toolCalls: [call(THINK_TOOL_NAME)], stopReason: "tool_use" }, // round 1: cap
      { deltas: ["still going"], toolCalls: [call(THINK_TOOL_NAME)], stopReason: "tool_use" }, // round 2: ignored warning
    ]);

    await runToolLoop(client, baseRequest, "test-model", "lmstudio", {} as never, signal(), cb, 1, true);

    expect(client.stream).toHaveBeenCalledTimes(3); // hard stop at round 2, no round 3
    expect(flushedAnswer(cb)).toBe("still going");
  });
});

describe("runToolLoop abort handling", () => {
  it("flushes partial answer text to the bubble when the stream throws mid-round", async () => {
    const cb = makeCallbacks();
    const client = {
      complete: vi.fn(),
      stream: () =>
        ({
          deltas: (async function* () {
            yield "partial answer";
            throw new Error("aborted");
          })(),
          usage: Promise.resolve(null),
          toolCalls: Promise.resolve(null),
          stopReason: Promise.resolve("end_turn"),
        }) as unknown as StreamResult,
    } as unknown as ChatClient;

    await expect(
      runToolLoop(client, baseRequest, "test-model", "lmstudio", {} as never, signal(), cb, 5, true),
    ).rejects.toThrow("aborted");

    // Partial text gathered before the abort is preserved for the aborted-response
    // finalizer rather than lost.
    expect(cb.onDelta).toHaveBeenCalledWith("partial answer");
  });
});

describe("runToolLoop step results", () => {
  it("reports an edit step outcome via onStepResult", async () => {
    const cb = { ...makeCallbacks(), onStepResult: vi.fn() };
    const editName = [...EDIT_TOOL_NAMES][0];
    const editCall: ToolCall = { id: "edit-1", name: editName, arguments: {} };

    // The live review resolves the edit (here: a decline) and returns the real
    // disposition, which the loop must surface through onStepResult.
    const liveReview = {
      resolveEdits: vi.fn(async () => [
        { tc: editCall, result: { isError: true, content: "Edit could not be applied." } },
      ]),
      resolveRound: vi.fn(async () => []),
    } as unknown as LiveVaultReview;

    // Minimal app: not a FileSystemAdapter and an empty name, so the path
    // normalizer returns every tool call untouched.
    const app = {
      vault: {
        adapter: {},
        getName: () => "",
        getAbstractFileByPath: () => null,
      },
    } as unknown as App;

    const client = countingClient([
      { deltas: ["Editing the note"], toolCalls: [editCall], stopReason: "tool_use" },
      { deltas: ["Done."], toolCalls: null, stopReason: "end_turn" },
    ]);

    await runToolLoop(
      client,
      baseRequest,
      "test-model",
      "lmstudio",
      {} as never,
      signal(),
      cb,
      5,
      true,
      undefined,
      undefined,
      { app, liveReview },
    );

    expect(cb.onStepResult).toHaveBeenCalledWith("edit-1", {
      isError: true,
      content: "Edit could not be applied.",
    });
  });
});

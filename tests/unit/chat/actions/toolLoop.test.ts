import { describe, it, expect, vi } from "vitest";
import { runToolLoop } from "../../../../src/chat/actions/toolLoop";
import type { ToolLoopCallbacks } from "../../../../src/chat/actions/toolLoop";
import type { ChatClient } from "../../../../src/api/chatClient";
import type { StreamResult } from "../../../../src/api/usageTypes";
import type { ChatRequest } from "../../../../src/shared/chatRequest";
import type { ToolCall } from "../../../../src/tools/types";
import { THINK_TOOL_NAME } from "../../../../src/tools/think/definition";

/**
 * Answer-track prose accumulation.
 *
 * Prose that narrates a mutating action (a write/edit/vault-op call) is part of
 * the user-facing answer — e.g. "Here's the file I created: ```…```" — and must
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
    5, // maxRounds — high enough to never cap
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
        { deltas: ["Done — the file is ready."], toolCalls: null, stopReason: "end_turn" },
      ],
      cb,
    );

    expect(flushedAnswer(cb)).toBe("Creating the file: ```md\n# Hi\n```\n\nDone — the file is ready.");
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

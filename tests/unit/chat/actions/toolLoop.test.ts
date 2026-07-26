import { describe, it, expect, vi } from "vitest";
import type { App } from "obsidian";
import {
  runToolLoop,
  classifyToolCalls,
  capRoundToMutation,
  resolveVaultOps,
  resolveEdits,
  applyIdenticalCallGuard,
  applyToolAllowGuard,
  IDENTICAL_CALL_THRESHOLD,
} from "../../../../src/chat/actions/toolLoop";
import type { ToolLoopCallbacks } from "../../../../src/chat/actions/toolLoop";
import type { ChatClient } from "../../../../src/api/chatClient";
import type {
  AssistantStreamEvent,
  StreamResult,
} from "../../../../src/api/usageTypes";
import type { ChatRequest } from "../../../../src/shared/chatRequest";
import type { ToolCall } from "../../../../src/tools/types";
import { THINK_TOOL_NAME } from "../../../../src/tools/think/definition";
import { EDIT_TOOL_NAMES } from "../../../../src/tools/editing/definition";
import { VAULT_TOOL_NAMES } from "../../../../src/tools/vault/definition";
import { VAULT_OPS_TOOL_NAMES } from "../../../../src/tools/vault-ops/definition";
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
  thinkingBlocks?: unknown[] | null;
}

function makeClient(rounds: RoundScript[]): ChatClient {
  let i = 0;
  return {
    complete: vi.fn(),
    stream: (): StreamResult => {
      const roundIndex = i++;
      return makeRoundStream(rounds[roundIndex], roundIndex);
    },
  } as unknown as ChatClient;
}

function makeCallbacks(): ToolLoopCallbacks & {
  onDelta: ReturnType<typeof vi.fn>;
} {
  return {
    onDelta: vi.fn(),
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

/** Exact prose bytes delivered in structural provider order. */
function flushedAnswer(cb: ReturnType<typeof makeCallbacks>): string {
  return cb.onDelta.mock.calls.map(([delta]) => delta).join("");
}

function makeRoundStream(
  round: RoundScript,
  roundIndex: number,
): StreamResult {
  const segmentId = `segment-${roundIndex}`;
  const events = (async function* (): AsyncGenerator<AssistantStreamEvent> {
    yield { type: "segment_start", segmentId };
    for (const delta of round.deltas) {
      yield { type: "prose_delta", segmentId, delta };
    }
    for (let index = 0; index < (round.toolCalls?.length ?? 0); index += 1) {
      const toolCall = round.toolCalls?.[index];
      if (!toolCall) continue;
      const declarationKey = `${segmentId}-tool-${index}`;
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
  const replayCapsule = round.thinkingBlocks
    ? {
        provider: "anthropic" as const,
        version: 1 as const,
        thinkingBlocks: round.thinkingBlocks as never,
      }
    : null;
  return {
    events,
    usage: Promise.resolve(null),
    stopReason: Promise.resolve(round.stopReason as never),
    replayCapsule: Promise.resolve(replayCapsule),
    replayEvidence: Promise.resolve({
      tier: replayCapsule ? "native" : "structural",
      capabilities: {
        captureOrder: "exact",
        toolCorrelation: "provider_id",
        coldReplay: "structural",
        nativeResume: false,
      },
    }),
  };
}

describe("runToolLoop anthropic thinking round trip", () => {
  // With adaptive thinking + tool use, Anthropic requires the response's
  // thinking blocks echoed back on the assistant tool-call turn. The loop
  // attaches whatever the client's StreamResult captured; the next round's
  // request must carry them on that turn (buildAnthropicMessages then emits
  // them first in the content array).
  it("attaches captured thinking blocks to the round's assistant turn", async () => {
    const thinking = [{ type: "thinking", thinking: "plan", signature: "sig" }];
    const seenRequests: ChatRequest[] = [];
    const rounds: Array<RoundScript & { thinkingBlocks?: unknown[] | null }> = [
      {
        deltas: ["considering"],
        toolCalls: [call(THINK_TOOL_NAME)],
        stopReason: "tool_use",
        thinkingBlocks: thinking,
      },
      { deltas: ["done"], toolCalls: null, stopReason: "end_turn" },
    ];
    let i = 0;
    const client = {
      complete: vi.fn(),
      stream: (request: ChatRequest): StreamResult => {
        seenRequests.push(request);
        const roundIndex = i++;
        return makeRoundStream(rounds[roundIndex], roundIndex);
      },
    } as unknown as ChatClient;

    await runToolLoop(
      client,
      baseRequest,
      "claude-opus-4-8",
      "anthropic",
      {} as never,
      new AbortController().signal,
      makeCallbacks(),
      5,
      true,
    );

    const round2Messages = seenRequests[1].messages;
    const assistantTurn = round2Messages.find((t) => t.role === "assistant");
    expect(assistantTurn?.anthropicThinkingBlocks).toEqual(thinking);
  });

  it("attaches nothing when the client captured no thinking (other providers)", async () => {
    const seenRequests: ChatRequest[] = [];
    const rounds: RoundScript[] = [
      { deltas: ["considering"], toolCalls: [call(THINK_TOOL_NAME)], stopReason: "tool_use" },
      { deltas: ["done"], toolCalls: null, stopReason: "end_turn" },
    ];
    let i = 0;
    const client = {
      complete: vi.fn(),
      stream: (request: ChatRequest): StreamResult => {
        seenRequests.push(request);
        const roundIndex = i++;
        return makeRoundStream(rounds[roundIndex], roundIndex);
      },
    } as unknown as ChatClient;

    await runToolLoop(
      client,
      baseRequest,
      "test-model",
      "lmstudio",
      {} as never,
      new AbortController().signal,
      makeCallbacks(),
      5,
      true,
    );

    const assistantTurn = seenRequests[1].messages.find((t) => t.role === "assistant");
    expect(assistantTurn).toBeDefined();
    expect(assistantTurn).not.toHaveProperty("anthropicThinkingBlocks");
  });
});

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

    expect(flushedAnswer(cb)).toBe("Creating the file: ```md\n# Hi\n```Done, the file is ready.");
  });

  it("keeps prose that precedes a read-only tool in canonical order", async () => {
    const cb = makeCallbacks();
    await run(
      [
        { deltas: ["Let me think about this"], toolCalls: [call(THINK_TOOL_NAME)], stopReason: "tool_use" },
        { deltas: ["Here is the answer."], toolCalls: null, stopReason: "end_turn" },
      ],
      cb,
    );

    expect(flushedAnswer(cb)).toBe(
      "Let me think about thisHere is the answer.",
    );
  });
});

/** A client that records how many times the model was streamed. */
function countingClient(rounds: RoundScript[]): ChatClient & { stream: ReturnType<typeof vi.fn> } {
  let i = 0;
  const stream = vi.fn((): StreamResult => {
    const roundIndex = i++;
    return makeRoundStream(rounds[roundIndex], roundIndex);
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
      { deltas: ["look 0"], toolCalls: [{ ...call(THINK_TOOL_NAME), id: "think-0" }], stopReason: "tool_use" }, // round 0
      { deltas: ["look 1"], toolCalls: [{ ...call(THINK_TOOL_NAME), id: "think-1" }], stopReason: "tool_use" }, // round 1: cap
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
    expect(flushedAnswer(cb)).toBe(
      "look 0look 1Here is what I found.",
    );
  });

  it("hard-stops when the model keeps calling tools after the cap warning", async () => {
    const cb = makeCallbacks();
    // No fourth round is scripted: if the loop failed to hard-stop it would read
    // past the script and throw, so a clean return proves the hard stop.
    const client = countingClient([
      { deltas: ["look 0"], toolCalls: [{ ...call(THINK_TOOL_NAME), id: "think-0" }], stopReason: "tool_use" }, // round 0
      { deltas: ["look 1"], toolCalls: [{ ...call(THINK_TOOL_NAME), id: "think-1" }], stopReason: "tool_use" }, // round 1: cap
      { deltas: ["still going"], toolCalls: [{ ...call(THINK_TOOL_NAME), id: "think-2" }], stopReason: "tool_use" }, // round 2: ignored warning
    ]);

    await runToolLoop(client, baseRequest, "test-model", "lmstudio", {} as never, signal(), cb, 1, true);

    expect(client.stream).toHaveBeenCalledTimes(3); // hard stop at round 2, no round 3
    expect(flushedAnswer(cb)).toBe("look 0look 1still going");
  });
});

/**
 * Buffer-and-drain of a deferred mutation batch. A model that ignores
 * parallel_tool_calls (LM Studio / llama.cpp) emits its whole batch in one assistant
 * message. The cap keeps one mutation per round; the rest are buffered and drained on
 * the following rounds with NO model stream, so a local model that never re-emits the
 * surplus (it thinks it is done) still has its full intent honored. This is the
 * regression lock for the "some ops finish, the rest hang pending and never run" symptom.
 */
describe("runToolLoop deferred-mutation drain", () => {
  const app = {
    vault: { adapter: {}, getName: () => "", getAbstractFileByPath: () => null },
  } as unknown as App;
  const vaultOpName = [...VAULT_OPS_TOOL_NAMES][0];

  it("drains a batched mutation set across rounds without the model re-emitting", async () => {
    const cb = makeCallbacks();
    const a: ToolCall = { id: "vo-a", name: vaultOpName, arguments: { path: "A" } };
    const b: ToolCall = { id: "vo-b", name: vaultOpName, arguments: { path: "B" } };
    const c: ToolCall = { id: "vo-c", name: vaultOpName, arguments: { path: "C" } };

    // The live review approves every op it is handed, one round at a time.
    const resolveRound = vi.fn(async (calls: ToolCall[]) =>
      calls.map((tc) => ({ tc, result: { isError: false, content: "op ok" } })),
    );
    const liveReview = {
      resolveRound,
      resolveEdits: vi.fn(async () => []),
    } as unknown as LiveVaultReview;

    // All three ops arrive in ONE assistant message; then the model (like a local model
    // that believes it has finished) says nothing further. The cap would classically
    // drop b and c for the model to re-emit; buffer-and-drain runs them regardless.
    const client = countingClient([
      { deltas: ["Making three folders."], toolCalls: [a, b, c], stopReason: "tool_use" },
      { deltas: ["Done."], toolCalls: null, stopReason: "end_turn" },
    ]);

    const result = await runToolLoop(
      client,
      baseRequest,
      "test-model",
      "lmstudio",
      {} as never,
      signal(),
      cb,
      20, // maxRounds high, so the cap can't interfere
      true,
      undefined,
      undefined,
      { app, liveReview },
    );

    // Streamed exactly twice: the batch, then the final "Done.", rounds for b and c
    // were replayed from the buffer with no stream.
    expect(client.stream).toHaveBeenCalledTimes(2);
    // Every op reached the gate, one per round, in emission order.
    expect(resolveRound).toHaveBeenCalledTimes(3);
    expect(resolveRound.mock.calls.map((mc) => (mc[0] as ToolCall[])[0].id)).toEqual([
      "vo-a",
      "vo-b",
      "vo-c",
    ]);
    // Current behavior creates one synthetic loop round per drained mutation. Phase 3
    // intentionally replaces this scheduling artifact while retaining declaration order.
    expect(cb.onNewRound).toHaveBeenCalledTimes(3);
    // Every op recorded a timeline step, none silently lost.
    const recorded = (cb.onStepRecorded as ReturnType<typeof vi.fn>).mock.calls.map(
      (cc) => cc[0].toolCallId,
    );
    expect(recorded).toEqual(["vo-a", "vo-b", "vo-c"]);
    // All three accumulate as write calls for finalization.
    expect(result.writeToolCalls?.map((w) => w.id)).toEqual(["vo-a", "vo-b", "vo-c"]);
  });
});

describe("runToolLoop abort handling", () => {
  it("flushes partial answer text to the bubble when the stream throws mid-round", async () => {
    const cb = makeCallbacks();
    const client = {
      complete: vi.fn(),
      stream: () =>
        ({
          events: (async function* (): AsyncGenerator<AssistantStreamEvent> {
            yield { type: "segment_start", segmentId: "segment-abort" };
            yield {
              type: "prose_delta",
              segmentId: "segment-abort",
              delta: "partial answer",
            };
            throw new Error("aborted");
          })(),
          usage: Promise.resolve(null),
          stopReason: Promise.resolve("end_turn"),
          replayCapsule: Promise.resolve(null),
          replayEvidence: Promise.resolve({
            tier: "textual",
            capabilities: {
              captureOrder: "text_only",
              toolCorrelation: "none",
              coldReplay: "textual",
              nativeResume: false,
            },
          }),
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

/**
 * Replay capture at the plugin tool-loop choke point (ADR-0016). The read channel records the digest + bounded
 * record with the result in hand; the vault-op / edit channel threads the reviewed
 * disposition through onStepResult. Pre-phase neither field existed.
 */
describe("runToolLoop phase-2 replay capture", () => {
  const app = {
    vault: { adapter: {}, getName: () => "", getAbstractFileByPath: () => null },
  } as unknown as App;

  const recordedStep = (cb: ReturnType<typeof makeCallbacks>, id: string) =>
    (cb.onStepRecorded as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).find((s) => s.toolCallId === id);

  it("captures a discovery digest + bounded record on the read choke point", async () => {
    const cb = makeCallbacks();
    // No vaultToolContext: the read resolves to an "unavailable" failure, which is
    // enough to prove the fields are captured here without a live RAG backend.
    const client = countingClient([
      {
        deltas: ["searching"],
        toolCalls: [{ id: "s-1", name: "semantic_search", arguments: { query: "oath" } }],
        stopReason: "tool_use",
      },
      { deltas: ["done"], toolCalls: null, stopReason: "end_turn" },
    ]);
    await runToolLoop(client, baseRequest, "test-model", "lmstudio", {} as never, signal(), cb, 20, true);

    const step = recordedStep(cb, "s-1");
    expect(step.resultRecord).toContain("vault tool context unavailable");
    expect(step.resultDigest).toBe('[semantic_search: "oath", FAILED: vault tool context unavailable]');
  });

  it("captures a bounded record but no digest for a non-discovery read", async () => {
    const cb = makeCallbacks();
    const client = countingClient([
      {
        deltas: ["reading"],
        toolCalls: [{ id: "r-1", name: "read_file", arguments: { path: "x.md" } }],
        stopReason: "tool_use",
      },
      { deltas: ["done"], toolCalls: null, stopReason: "end_turn" },
    ]);
    await runToolLoop(client, baseRequest, "test-model", "lmstudio", {} as never, signal(), cb, 20, true);

    const step = recordedStep(cb, "r-1");
    expect(step.resultRecord).toContain("vault tool context unavailable");
    expect(step.resultDigest).toBeUndefined();
  });

  it("threads a reviewed vault-op disposition through onStepResult (write choke point)", async () => {
    const cb = { ...makeCallbacks(), onStepResult: vi.fn() };
    const vaultOpName = [...VAULT_OPS_TOOL_NAMES][0];
    const opCall: ToolCall = { id: "vo-1", name: vaultOpName, arguments: { path: "Drafts/Arcs" } };
    const liveReview = {
      resolveRound: vi.fn(async (calls: ToolCall[]) =>
        calls.map((tc) => ({
          tc,
          result: { isError: false, content: "Declined by user.", disposition: "declined" as const },
        })),
      ),
      resolveEdits: vi.fn(async () => []),
    } as unknown as LiveVaultReview;

    const client = countingClient([
      { deltas: ["making a folder"], toolCalls: [opCall], stopReason: "tool_use" },
      { deltas: ["done"], toolCalls: null, stopReason: "end_turn" },
    ]);
    await runToolLoop(
      client, baseRequest, "test-model", "lmstudio", {} as never, signal(), cb, 20, true,
      undefined, undefined, { app, liveReview },
    );

    expect(cb.onStepResult).toHaveBeenCalledWith("vo-1", {
      isError: false,
      content: "Declined by user.",
      disposition: "declined",
    });
  });

  it("threads each disposition value distinctly (applied / failed)", async () => {
    const vaultOpName = [...VAULT_OPS_TOOL_NAMES][0];
    for (const disposition of ["applied", "failed"] as const) {
      const cb = { ...makeCallbacks(), onStepResult: vi.fn() };
      const opCall: ToolCall = { id: "vo-x", name: vaultOpName, arguments: { path: "A" } };
      const liveReview = {
        resolveRound: vi.fn(async (calls: ToolCall[]) =>
          calls.map((tc) => ({ tc, result: { isError: disposition === "failed", content: "outcome", disposition } })),
        ),
        resolveEdits: vi.fn(async () => []),
      } as unknown as LiveVaultReview;

      const client = countingClient([
        { deltas: ["op"], toolCalls: [opCall], stopReason: "tool_use" },
        { deltas: ["done"], toolCalls: null, stopReason: "end_turn" },
      ]);
      await runToolLoop(
        client, baseRequest, "test-model", "lmstudio", {} as never, signal(), cb, 20, true,
        undefined, undefined, { app, liveReview },
      );

      expect(cb.onStepResult).toHaveBeenCalledWith("vo-x", expect.objectContaining({ disposition }));
    }
  });
});

/**
 * Callback-sequence characterization. The P1-15 decomposition (lifting the
 * in-loop resolvers to module level + extracting call classification) is a
 * behavior-preserving refactor of streaming, concurrent, callback-heavy code,
 * exactly where a silent reorder hides. This records the FULL interleaved order
 * of every callback across a representative multi-round turn that drives all
 * three concurrent channels in one round (read-only vault tool + vault-op +
 * edit). It is the lock the refactor must keep green: the order of
 * onDelta / onToolStatus / onStepRecorded / onStepResult / onNewRound must
 * retain declaration-driven order.
 */
describe("runToolLoop callback-sequence characterization", () => {
  // Minimal app: not a FileSystemAdapter and an empty name, so the path
  // normalizer returns every tool call untouched (matches the step-result test).
  const app = {
    vault: { adapter: {}, getName: () => "", getAbstractFileByPath: () => null },
  } as unknown as App;

  function recordingCallbacks(seq: string[]): ToolLoopCallbacks {
    return {
      onDelta: (text) => seq.push(`delta:${text}`),
      onToolStatus: (name) => seq.push(`status:${name}`),
      onStepRecorded: (step) => seq.push(`recorded:${step.toolName}:${step.toolCallId}`),
      onStepResult: (id, result) => seq.push(`result:${id}:${result.isError ? "err" : "ok"}`),
      onNewRound: () => seq.push("newRound"),
    };
  }

  it("preserves the exact interleaved callback order across a three-channel turn", async () => {
    const seq: string[] = [];
    const vaultName = [...VAULT_TOOL_NAMES][0];
    const vaultOpName = [...VAULT_OPS_TOOL_NAMES][0];
    const editName = [...EDIT_TOOL_NAMES][0];

    const vr0: ToolCall = { id: "vr-0", name: vaultName, arguments: {} };
    const th0: ToolCall = { id: "th-0", name: THINK_TOOL_NAME, arguments: {} };
    const vr1: ToolCall = { id: "vr-1", name: vaultName, arguments: {} };
    const vo1: ToolCall = { id: "vo-1", name: vaultOpName, arguments: {} };
    const ed1: ToolCall = { id: "ed-1", name: editName, arguments: {} };

    // Live review returns real dispositions for the vault-op and edit channels.
    const liveReview = {
      resolveRound: vi.fn(async (calls: ToolCall[]) =>
        calls.map((tc) => ({ tc, result: { isError: false, content: "op ok" } })),
      ),
      resolveEdits: vi.fn(async (calls: ToolCall[]) =>
        calls.map((tc) => ({ tc, result: { isError: false, content: "edit ok" } })),
      ),
    } as unknown as LiveVaultReview;

    const client = countingClient([
      // Round 0: read-only reasoning round (vault search + think) → committed reasoning.
      { deltas: ["Let me look around. "], toolCalls: [vr0, th0], stopReason: "tool_use" },
      // Round 1: read + vault-op + edit, but the mutation cap keeps only up to the first
      // mutation (vr1 + vo1) and defers the second mutation (ed1) so the model gets the
      // vault-op's approval result before the edit is gated. Mutating narration →
      // answer-track.
      { deltas: ["Now I'll make changes."], toolCalls: [vr1, vo1, ed1], stopReason: "tool_use" },
      // Round 3: final answer → single post-loop flush. (Round 2 is the drained edit,
      // replayed from the buffer with no model stream, so the model is streamed 3 times
      // across 4 rounds.)
      { deltas: ["All done."], toolCalls: null, stopReason: "end_turn" },
    ]);

    await runToolLoop(
      client,
      baseRequest,
      "test-model",
      "lmstudio",
      {} as never,
      signal(),
      recordingCallbacks(seq),
      5,
      true,
      undefined,
      undefined,
      { app, liveReview },
    );

    expect(seq).toEqual([
      // Round 0 prose is visible in declaration order, then tools execute.
      "delta:Let me look around. ",
      `status:${vaultName}`,
      `recorded:${vaultName}:vr-0`,
      `recorded:${THINK_TOOL_NAME}:th-0`,
      "newRound",
      // Round 1 keeps its prose. The mutation cap kept vr1 + vo1 and deferred the trailing edit
      // (ed1), so only the read-only and
      // vault-op channels fire their synchronous prefixes in array order (read-only
      // status, then vault-op status+record), and the post-await processing records the
      // read-only step and reports the single vault-op disposition.
      "delta:Now I'll make changes.",
      `status:${vaultName}`,
      `status:${vaultOpName}`,
      `recorded:${vaultOpName}:vo-1`,
      `recorded:${vaultName}:vr-1`,
      "result:vo-1:ok",
      "newRound",
      // Round 2 drains the deferred edit with no provider prose.
      `status:${editName}`,
      `recorded:${editName}:ed-1`,
      "result:ed-1:ok",
      "newRound",
      // Round 3 final prose remains the last declared item.
      "delta:All done.",
    ]);
  });
});

/**
 * Direct unit tests for the helpers the P1-15 decomposition lifted out of the
 * loop body. As in-loop closures these branches were reachable only end-to-end;
 * extracted, each is asserted in isolation.
 */
describe("classifyToolCalls", () => {
  const ids = (calls: ToolCall[]): string[] => calls.map((c) => c.id);
  const vaultName = [...VAULT_TOOL_NAMES][0];
  const vaultOpName = [...VAULT_OPS_TOOL_NAMES][0];
  const editName = [...EDIT_TOOL_NAMES][0];

  it("partitions a mixed round into loop / unknown / edit / vault-op / vault / think buckets", () => {
    const c = classifyToolCalls([
      { id: "u", name: "custom_write", arguments: {} },
      { id: "e", name: editName, arguments: {} },
      { id: "o", name: vaultOpName, arguments: {} },
      { id: "v", name: vaultName, arguments: {} },
      { id: "t", name: THINK_TOOL_NAME, arguments: {} },
    ]);

    // unknown is the only non-loop tool; loopCalls is everything else.
    expect(ids(c.unknownCalls)).toEqual(["u"]);
    expect(ids(c.loopCalls)).toEqual(["e", "o", "v", "t"]);
    expect(ids(c.editCalls)).toEqual(["e"]);
    expect(ids(c.vaultOpCalls)).toEqual(["o"]);
    expect(ids(c.vaultCalls)).toEqual(["v"]);
    expect(ids(c.thinkCalls)).toEqual(["t"]);
  });

  it("returns all-empty buckets for no calls", () => {
    const c = classifyToolCalls([]);
    expect(c.loopCalls).toEqual([]);
    expect(c.unknownCalls).toEqual([]);
    expect(c.editCalls).toEqual([]);
    expect(c.vaultOpCalls).toEqual([]);
    expect(c.vaultCalls).toEqual([]);
    expect(c.thinkCalls).toEqual([]);
  });
});

describe("capRoundToMutation", () => {
  const ids = (calls: ToolCall[]): string[] => calls.map((c) => c.id);
  const vaultName = [...VAULT_TOOL_NAMES][0];
  const vaultOpName = [...VAULT_OPS_TOOL_NAMES][0];
  const editName = [...EDIT_TOOL_NAMES][0];

  it("keeps only the first of several vault-op mutations (the screenshot case)", () => {
    // Five create_directory-style ops emitted in one assistant message: only the first
    // survives so the approval gate can feed its decision back before the next.
    const calls: ToolCall[] = ["a", "b", "c", "d", "e"].map((id) => ({
      id,
      name: vaultOpName,
      arguments: {},
    }));
    expect(ids(capRoundToMutation(calls))).toEqual(["a"]);
  });

  it("keeps read-only / think calls that precede the first mutation, drops the rest", () => {
    const calls: ToolCall[] = [
      { id: "v", name: vaultName, arguments: {} },
      { id: "t", name: THINK_TOOL_NAME, arguments: {} },
      { id: "o", name: vaultOpName, arguments: {} },
      { id: "e", name: editName, arguments: {} },
    ];
    // Reads + think + the first mutation (vault-op) stay; the trailing edit is dropped.
    expect(ids(capRoundToMutation(calls))).toEqual(["v", "t", "o"]);
  });

  it("treats an edit as a mutation", () => {
    const calls: ToolCall[] = [
      { id: "e1", name: editName, arguments: {} },
      { id: "e2", name: editName, arguments: {} },
    ];
    expect(ids(capRoundToMutation(calls))).toEqual(["e1"]);
  });

  it("treats an unknown (non-loop) tool as a mutation", () => {
    const calls: ToolCall[] = [
      { id: "u1", name: "custom_write", arguments: {} },
      { id: "u2", name: "custom_write", arguments: {} },
    ];
    expect(ids(capRoundToMutation(calls))).toEqual(["u1"]);
  });

  it("leaves a pure read-only / think round untouched (reads stay parallel)", () => {
    const calls: ToolCall[] = [
      { id: "v1", name: vaultName, arguments: {} },
      { id: "v2", name: vaultName, arguments: {} },
      { id: "t", name: THINK_TOOL_NAME, arguments: {} },
    ];
    expect(ids(capRoundToMutation(calls))).toEqual(["v1", "v2", "t"]);
  });

  it("leaves a single-mutation round untouched", () => {
    const calls: ToolCall[] = [
      { id: "v", name: vaultName, arguments: {} },
      { id: "o", name: vaultOpName, arguments: {} },
    ];
    expect(ids(capRoundToMutation(calls))).toEqual(["v", "o"]);
  });

  it("returns an empty round unchanged", () => {
    expect(capRoundToMutation([])).toEqual([]);
  });
});

describe("resolveVaultOps", () => {
  const vaultOpName = [...VAULT_OPS_TOOL_NAMES][0];
  const op = (id: string): ToolCall => ({ id, name: vaultOpName, arguments: {} });

  function callbacksSpy() {
    return { onToolStatus: vi.fn(), onStepRecorded: vi.fn() } as unknown as ToolLoopCallbacks & {
      onToolStatus: ReturnType<typeof vi.fn>;
      onStepRecorded: ReturnType<typeof vi.fn>;
    };
  }

  it("returns [] and fires no callbacks when there are no vault-op calls", async () => {
    const cb = callbacksSpy();
    const result = await resolveVaultOps({
      vaultOpCalls: [],
      priorVaultOpCalls: [],
      round: 0,
      stopReason: "end_turn",
      context: undefined,
      callbacks: cb,
    });
    expect(result).toEqual([]);
    expect(cb.onToolStatus).not.toHaveBeenCalled();
    expect(cb.onStepRecorded).not.toHaveBeenCalled();
  });

  it("records steps, routes to the live review, and forwards the max_tokens flag", async () => {
    const cb = callbacksSpy();
    const dispositions = [{ tc: op("vo-1"), result: { isError: false, content: "op ok" } }];
    const liveReview = {
      resolveRound: vi.fn(async () => dispositions),
      resolveEdits: vi.fn(async () => []),
    } as unknown as LiveVaultReview;

    const result = await resolveVaultOps({
      vaultOpCalls: [op("vo-1")],
      priorVaultOpCalls: [],
      round: 2,
      stopReason: "max_tokens",
      context: { app: {} as unknown as App, liveReview },
      callbacks: cb,
    });

    // Step recorded BEFORE resolution; disposition passed straight through.
    expect(cb.onToolStatus).toHaveBeenCalledWith(vaultOpName);
    expect(cb.onStepRecorded).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tool_call", round: 2, toolCallId: "vo-1" }),
    );
    // The load-bearing arg: stopReason === "max_tokens" tells the review the model
    // was truncated, so it must arrive as `true`.
    expect(liveReview.resolveRound).toHaveBeenCalledWith([op("vo-1")], true);
    expect(result).toBe(dispositions);
  });

  it("passes max_tokens=false to the live review on a normal stop", async () => {
    const liveReview = {
      resolveRound: vi.fn(async () => []),
      resolveEdits: vi.fn(async () => []),
    } as unknown as LiveVaultReview;

    await resolveVaultOps({
      vaultOpCalls: [op("vo-1")],
      priorVaultOpCalls: [],
      round: 0,
      stopReason: "tool_use",
      context: { app: {} as unknown as App, liveReview },
      callbacks: callbacksSpy(),
    });

    expect(liveReview.resolveRound).toHaveBeenCalledWith([op("vo-1")], false);
  });

  it("falls back to an unavailable failure when no context is supplied", async () => {
    const result = await resolveVaultOps({
      vaultOpCalls: [op("vo-1")],
      priorVaultOpCalls: [],
      round: 0,
      stopReason: "end_turn",
      context: undefined,
      callbacks: callbacksSpy(),
    });
    expect(result).toHaveLength(1);
    expect(result[0].result.isError).toBe(true);
    expect(result[0].result.content).toContain("vault operation context unavailable");
  });
});

describe("resolveEdits", () => {
  const editName = [...EDIT_TOOL_NAMES][0];
  const edit = (id: string): ToolCall => ({ id, name: editName, arguments: {} });

  function callbacksSpy() {
    return { onToolStatus: vi.fn(), onStepRecorded: vi.fn() } as unknown as ToolLoopCallbacks & {
      onToolStatus: ReturnType<typeof vi.fn>;
      onStepRecorded: ReturnType<typeof vi.fn>;
    };
  }

  it("returns [] and fires no callbacks when there are no edit calls", async () => {
    const cb = callbacksSpy();
    const result = await resolveEdits({
      editCalls: [],
      vaultOpContext: undefined,
      editContext: undefined,
      round: 0,
      callbacks: cb,
    });
    expect(result).toEqual([]);
    expect(cb.onToolStatus).not.toHaveBeenCalled();
    expect(cb.onStepRecorded).not.toHaveBeenCalled();
  });

  it("records steps and routes to the live review when one is present", async () => {
    const cb = callbacksSpy();
    const dispositions = [{ tc: edit("ed-1"), result: { isError: false, content: "edit ok" } }];
    const liveReview = {
      resolveRound: vi.fn(async () => []),
      resolveEdits: vi.fn(async () => dispositions),
    } as unknown as LiveVaultReview;

    const result = await resolveEdits({
      editCalls: [edit("ed-1")],
      vaultOpContext: { app: {} as unknown as App, liveReview },
      editContext: undefined,
      round: 1,
      callbacks: cb,
    });

    expect(cb.onToolStatus).toHaveBeenCalledWith(editName);
    expect(cb.onStepRecorded).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tool_call", round: 1, toolCallId: "ed-1" }),
    );
    expect(liveReview.resolveEdits).toHaveBeenCalledWith([edit("ed-1")]);
    expect(result).toBe(dispositions);
  });

  it("falls back to an unavailable failure when neither a live review nor an edit context exists", async () => {
    const result = await resolveEdits({
      editCalls: [edit("ed-1")],
      vaultOpContext: undefined,
      editContext: undefined,
      round: 0,
      callbacks: callbacksSpy(),
    });
    expect(result).toHaveLength(1);
    expect(result[0].result.isError).toBe(true);
    expect(result[0].result.content).toContain("edit tool context unavailable");
  });
});

/**
 * D5, per-turn identical-call spin guard. The threshold is
 * {@link IDENTICAL_CALL_THRESHOLD} (3): the first three identical
 * (tool name + canonicalized arguments) calls run, the fourth is refused with a
 * recovery-shaped `precondition` failure rather than executing. Keyed on the
 * canonical args so key order doesn't matter and distinct args never collide.
 */
describe("applyIdenticalCallGuard", () => {
  const readName = [...VAULT_TOOL_NAMES][0];
  const mk = (id: string, args: Record<string, unknown> = {}): ToolCall => ({
    id,
    name: readName,
    arguments: args,
  });

  it("allows the first three identical calls and refuses the fourth", () => {
    const counts = new Map<string, number>();
    const r1 = applyIdenticalCallGuard([mk("a1")], counts);
    const r2 = applyIdenticalCallGuard([mk("a2")], counts);
    const r3 = applyIdenticalCallGuard([mk("a3")], counts);
    const r4 = applyIdenticalCallGuard([mk("a4")], counts);

    expect(r1.blockedIds.size).toBe(0);
    expect(r2.blockedIds.size).toBe(0);
    expect(r3.blockedIds.size).toBe(0);
    expect(r4.blockedIds.has("a4")).toBe(true);

    const refusal = r4.blockedResults[0].result;
    expect(refusal.isError).toBe(true);
    expect(refusal.failure?.kind).toBe("precondition");
    expect(refusal.content).toContain("already called");
    expect(refusal.content).toContain(String(IDENTICAL_CALL_THRESHOLD));
  });

  it("blocks the fourth identical call within a single round", () => {
    const counts = new Map<string, number>();
    const { blockedIds } = applyIdenticalCallGuard(
      [mk("a"), mk("b"), mk("c"), mk("d")],
      counts,
    );
    expect([...blockedIds]).toEqual(["d"]);
  });

  it("keys on canonical args, so key order does not matter", () => {
    const counts = new Map<string, number>();
    applyIdenticalCallGuard([mk("a", { a: 1, b: 2 })], counts);
    applyIdenticalCallGuard([mk("b", { b: 2, a: 1 })], counts);
    applyIdenticalCallGuard([mk("c", { a: 1, b: 2 })], counts);
    const r4 = applyIdenticalCallGuard([mk("d", { b: 2, a: 1 })], counts);
    expect(r4.blockedIds.has("d")).toBe(true);
  });

  it("counts each distinct argument set independently", () => {
    const counts = new Map<string, number>();
    // Five calls, all distinct paths: none ever repeats, so none is blocked.
    for (let i = 0; i < 5; i++) {
      const { blockedIds } = applyIdenticalCallGuard([mk(`x${i}`, { path: `note-${i}.md` })], counts);
      expect(blockedIds.size).toBe(0);
    }
    // A second call to an already-seen path is only the 2nd for that key, still allowed.
    const r = applyIdenticalCallGuard([mk("y", { path: "note-0.md" })], counts);
    expect(r.blockedIds.size).toBe(0);
  });
});

/**
 * Tool allow-list guard (section 6.1.4/section 6.3). The stable cloud surface advertises more than
 * the session permits, so a call whose tool the session disallows (a deny-classed write
 * under the ask posture) is refused before it runs. Reads are unrestricted on cloud, so
 * only not-permitted writes are blocked. Local providers pass no allow-list (no-op).
 */
describe("applyToolAllowGuard", () => {
  const readName = [...VAULT_TOOL_NAMES][0];
  const writeName = [...VAULT_OPS_TOOL_NAMES][0];
  const mk = (id: string, name: string): ToolCall => ({ id, name, arguments: {} });

  it("is a no-op when no allow-list is supplied (local providers)", () => {
    const r = applyToolAllowGuard([mk("a", writeName)], undefined);
    expect(r.blockedIds.size).toBe(0);
    expect(r.blockedResults).toEqual([]);
  });

  it("allows a call whose tool is in the allow-list", () => {
    const r = applyToolAllowGuard([mk("a", readName)], [readName]);
    expect(r.blockedIds.size).toBe(0);
  });

  it("refuses a call whose tool the mode does not permit", () => {
    const r = applyToolAllowGuard([mk("a", readName), mk("b", writeName)], [readName]);
    expect([...r.blockedIds]).toEqual(["b"]);
    const refusal = r.blockedResults[0].result;
    expect(refusal.isError).toBe(true);
    expect(refusal.failure?.kind).toBe("precondition");
    expect(refusal.content).toContain(writeName);
  });
});

describe("runToolLoop tool allow-list", () => {
  it("refuses a not-permitted write and never accumulates it as a write call", async () => {
    const cb = makeCallbacks();
    const readName = [...VAULT_TOOL_NAMES][0];
    const writeName = [...VAULT_OPS_TOOL_NAMES][0];
    const client = countingClient([
      {
        deltas: ["r0"],
        toolCalls: [{ id: "w0", name: writeName, arguments: { path: "x.md" } }],
        stopReason: "tool_use",
      },
      { deltas: ["done"], toolCalls: null, stopReason: "end_turn" },
    ]);

    // The session permits only the read tool; the advertised write is gated off.
    const request = { ...baseRequest, allowedToolNames: [readName] } as ChatRequest;
    const result = await runToolLoop(
      client,
      request,
      "test-model",
      "anthropic",
      {} as never,
      signal(),
      cb,
      20,
      true,
    );

    // Refused at the allow-list, so it never reached the write-finalization pipeline.
    expect(result.writeToolCalls).toBeNull();
    const recorded = (cb.onStepRecorded as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    const errors = recorded.filter((s) => s.isError).map((s) => s.errorContent as string);
    expect(errors.filter((e) => e.includes("not permitted in this session"))).toHaveLength(1);
  });

  it("lets an in-mode call through the gate to execute", async () => {
    const cb = makeCallbacks();
    const readName = [...VAULT_TOOL_NAMES][0];
    const client = countingClient([
      {
        deltas: ["r0"],
        toolCalls: [{ id: "r-call", name: readName, arguments: { path: "x.md" } }],
        stopReason: "tool_use",
      },
      { deltas: ["done"], toolCalls: null, stopReason: "end_turn" },
    ]);
    const request = { ...baseRequest, allowedToolNames: [readName] } as ChatRequest;
    await runToolLoop(client, request, "test-model", "anthropic", {} as never, signal(), cb, 20, true);

    // No vault context, so the permitted read executes and returns "unavailable", it
    // was NOT blocked by the mode gate (proving the gate let it through).
    const recorded = (cb.onStepRecorded as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    const errors = recorded.filter((s) => s.isError).map((s) => s.errorContent as string);
    expect(errors.some((e) => e.includes("not available in the current mode"))).toBe(false);
    expect(errors.some((e) => e.includes("vault tool context unavailable"))).toBe(true);
  });
});

describe("runToolLoop identical-call guard", () => {
  it("refuses the fourth identical tool call and never executes it", async () => {
    const cb = makeCallbacks();
    const vaultName = [...VAULT_TOOL_NAMES][0];
    // Fresh id per round (providers assign new ids), same name + args each time.
    const mkCall = (id: string): ToolCall => ({
      id,
      name: vaultName,
      arguments: { path: "Note.md" },
    });

    const client = countingClient([
      { deltas: ["r0"], toolCalls: [mkCall("c0")], stopReason: "tool_use" },
      { deltas: ["r1"], toolCalls: [mkCall("c1")], stopReason: "tool_use" },
      { deltas: ["r2"], toolCalls: [mkCall("c2")], stopReason: "tool_use" },
      { deltas: ["r3"], toolCalls: [mkCall("c3")], stopReason: "tool_use" },
      { deltas: ["done"], toolCalls: null, stopReason: "end_turn" },
    ]);

    // No vaultToolContext: an *executed* read returns an "unavailable" failure, so
    // the three executions are distinguishable from the blocked 4th, which returns
    // the precondition refusal and proves it never ran.
    await runToolLoop(
      client,
      baseRequest,
      "test-model",
      "lmstudio",
      {} as never,
      signal(),
      cb,
      20, // maxRounds high, so the round cap can't interfere
      true,
    );

    const recorded = (cb.onStepRecorded as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    const errors = recorded.filter((s) => s.isError).map((s) => s.errorContent as string);
    expect(errors.filter((e) => e.includes("vault tool context unavailable"))).toHaveLength(3);
    expect(errors.filter((e) => e.includes("already called"))).toHaveLength(1);
  });
});

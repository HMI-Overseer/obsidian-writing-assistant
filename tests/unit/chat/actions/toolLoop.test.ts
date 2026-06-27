import { describe, it, expect, vi } from "vitest";
import type { App } from "obsidian";
import {
  runToolLoop,
  classifyToolCalls,
  resolveVaultOps,
  resolveEdits,
  applyIdenticalCallGuard,
  IDENTICAL_CALL_THRESHOLD,
} from "../../../../src/chat/actions/toolLoop";
import type { ToolLoopCallbacks } from "../../../../src/chat/actions/toolLoop";
import type { ChatClient } from "../../../../src/api/chatClient";
import type { StreamResult } from "../../../../src/api/usageTypes";
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

/**
 * Callback-sequence characterization. The P1-15 decomposition (lifting the
 * in-loop resolvers to module level + extracting call classification) is a
 * behavior-preserving refactor of streaming, concurrent, callback-heavy code,
 * exactly where a silent reorder hides. This records the FULL interleaved order
 * of every callback across a representative multi-round turn that drives all
 * three concurrent channels in one round (read-only vault tool + vault-op +
 * edit). It is the lock the refactor must keep green: the order of
 * onReasoningDelta / onReasoningRoundFinished / onToolStatus / onStepRecorded /
 * onStepResult / onNewRound / onDelta must not change.
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
      onReasoningDelta: (text) => seq.push(`rdelta:${text}`),
      onReasoningRoundFinished: (committed, round) => seq.push(`rrf:${committed}:${round}`),
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
      // Round 1: all three concurrent channels + mutating narration → answer-track.
      { deltas: ["Now I'll make changes."], toolCalls: [vr1, vo1, ed1], stopReason: "tool_use" },
      // Round 2: final answer → single post-loop flush.
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
      // Round 0 — read-only round: reasoning committed, then the read-only branch.
      "rdelta:Let me look around. ",
      "rrf:true:0",
      `status:${vaultName}`,
      `recorded:${vaultName}:vr-0`,
      `recorded:${THINK_TOOL_NAME}:th-0`,
      "newRound",
      // Round 1 — mutating round: answer-track reasoning discarded, then the three
      // concurrent channels fire their synchronous prefixes in array order
      // (read-only status, then vault-op status+record, then edit status+record),
      // and the post-await processing records the read-only step and reports the
      // vault-op / edit dispositions.
      "rdelta:Now I'll make changes.",
      "rrf:false:1",
      `status:${vaultName}`,
      `status:${vaultOpName}`,
      `recorded:${vaultOpName}:vo-1`,
      `status:${editName}`,
      `recorded:${editName}:ed-1`,
      `recorded:${vaultName}:vr-1`,
      "result:vo-1:ok",
      "result:ed-1:ok",
      "newRound",
      // Round 2 — final answer: committed false, loop breaks, single bubble flush.
      "rdelta:All done.",
      "rrf:false:2",
      "delta:Now I'll make changes.\n\nAll done.",
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

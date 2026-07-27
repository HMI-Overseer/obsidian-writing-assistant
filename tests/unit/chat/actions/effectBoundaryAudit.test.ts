import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { ChatClient } from "../../../../src/api/chatClient";
import type { AssistantStreamRun } from "../../../../src/api/assistantStreamRun";
import type { AssistantStreamEvent } from "../../../../src/api/usageTypes";
import {
  resolveEdits,
  resolveMemories,
  resolveVaultOps,
  runToolLoop,
} from "../../../../src/chat/actions/toolLoop";
import type { ToolLoopCallbacks } from "../../../../src/chat/actions/toolLoop";
import type { LiveVaultReview } from "../../../../src/chat/actions/liveVaultReview";
import { crossWithDurableIntent } from "../../../../src/shared/generationAudit";
import type { ChatRequest } from "../../../../src/shared/chatRequest";
import type {
  EffectIntentRequest,
  EffectRunOwnership,
  GenerationAuditRecorder,
} from "../../../../src/shared/types";
import type { AskUserResponder } from "../../../../src/tools/ask/types";
import type { ToolCall, ToolResult } from "../../../../src/tools/types";
import { ownedRunFromLegacy } from "../../../helpers/ownedRun";

/**
 * RFC-0011 phase 6, plan section 9.1: no irreversible effect crosses its
 * boundary until its intent is durable.
 *
 * The boundary is provider-neutral. Phase 5 built it on Claude Code's callback
 * path because that is where the ownership defect lived, but the plugin's own
 * tool loop crosses the same four boundaries through the same review owner, and
 * criterion 29 is not provider-scoped. These cases cover the shared ordering and
 * the plugin loop's half of it; the Claude half is in
 * `tests/unit/services/claudeCodeCallbackOwnership.test.ts`.
 *
 * Every case uses a controllable promise, so "the store write is in flight" is a
 * state the test holds rather than a race it hopes for.
 */

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** A recorder whose durability the test drives. */
function recorder(behaviour: { fail?: Error; held?: Promise<void> } = {}) {
  const recorded: EffectIntentRequest[] = [];
  const reconciled: EffectIntentRequest[] = [];
  const ownerships: EffectRunOwnership[] = [];
  const port: GenerationAuditRecorder = {
    recordIntent: async (request, ownership) => {
      recorded.push(request);
      ownerships.push(ownership);
      if (behaviour.held) await behaviour.held;
      if (behaviour.fail) throw behaviour.fail;
    },
    reconcileIntent: (request) => {
      reconciled.push(request);
      return Promise.resolve();
    },
  };
  return { port, recorded, reconciled, ownerships };
}

const intent: EffectIntentRequest = {
  boundary: "vault_op_review",
  family: "vault_op",
  correlation: { kind: "provider_id", toolCallId: "toolu_1" },
  targetId: "Notes/target.md",
  summary: "write_file Notes/target.md",
};

describe("durable-intent crossing", () => {
  it("refuses without writing anything when the run is already signalled", async () => {
    const audit = recorder();

    const crossed = await crossWithDurableIntent("vault_op_review", intent, {
      isLive: () => false,
      audit: audit.port,
      ownership: () => ({ leaseId: "lease-1", attemptOrdinal: 1 }),
    });

    expect(crossed).toBe(false);
    // A dead run costs no store round trip.
    expect(audit.recorded).toEqual([]);
  });

  it("crosses only after the intent is durable", async () => {
    const held = gate();
    const audit = recorder({ held: held.promise });
    const order: string[] = [];

    const crossing = crossWithDurableIntent("vault_op_review", intent, {
      isLive: () => true,
      audit: audit.port,
      ownership: () => ({ leaseId: "lease-1", attemptOrdinal: 2 }),
      onCrossed: () => order.push("crossed"),
    });

    await Promise.resolve();
    expect(audit.recorded).toHaveLength(1);
    expect(order).toEqual([]);

    held.open();
    await expect(crossing).resolves.toBe(true);
    expect(order).toEqual(["crossed"]);
    expect(audit.ownerships[0]).toEqual({ leaseId: "lease-1", attemptOrdinal: 2 });
  });

  it("refuses when the intent cannot be made durable", async () => {
    const audit = recorder({ fail: new Error("disk full") });
    const crossed = await crossWithDurableIntent("edit_review", intent, {
      isLive: () => true,
      audit: audit.port,
      ownership: () => ({ leaseId: "lease-1", attemptOrdinal: 1 }),
      onCrossed: () => expect.fail("crossed without durable evidence"),
    });

    expect(crossed).toBe(false);
  });

  it("refuses a stop that lands while the intent is persisting, and reconciles it", async () => {
    const held = gate();
    const audit = recorder({ held: held.promise });
    let live = true;

    const crossing = crossWithDurableIntent("vault_op_review", intent, {
      isLive: () => live,
      audit: audit.port,
      ownership: () => ({ leaseId: "lease-1", attemptOrdinal: 1 }),
      onCrossed: () => expect.fail("crossed after the run was signalled"),
    });
    await Promise.resolve();
    live = false;
    held.open();

    await expect(crossing).resolves.toBe(false);
    // Nothing happened, so the intent is reconciled rather than left to become
    // an unknown outcome that would overstate what we do not know.
    expect(audit.reconciled).toEqual([intent]);
  });
});

const app = {
  vault: {
    configDir: ".obsidian",
    getName: () => "Vault",
    getAbstractFileByPath: () => null,
    getFileByPath: () => null,
    getFolderByPath: () => null,
    getAllLoadedFiles: () => [],
    adapter: {},
  },
} as unknown as App;

function callbacks(): ToolLoopCallbacks {
  return { onDelta: vi.fn(), onStepRecorded: vi.fn(), onStepResult: vi.fn() };
}

/** A review that records what reached it, so a refusal is visible as absence. */
function review() {
  const seen: string[] = [];
  const result = (tc: ToolCall): Promise<Array<{ tc: ToolCall; result: ToolResult }>> => {
    seen.push(tc.name);
    return Promise.resolve([{ tc, result: { content: "applied", isError: false } }]);
  };
  return {
    seen,
    live: {
      resolveRound: (calls: ToolCall[]) => result(calls[0]),
      resolveEdits: (calls: ToolCall[]) => result(calls[0]),
      resolveMemories: (calls: ToolCall[]) => result(calls[0]),
    } as unknown as LiveVaultReview,
  };
}

const writeCall: ToolCall = {
  id: "toolu_write",
  name: "write_file",
  arguments: { path: "Notes/target.md", content: "body" },
};
const editCall: ToolCall = {
  id: "toolu_edit",
  name: "propose_edit",
  arguments: { path: "Notes/target.md", edits: [] },
};
const memoryCall: ToolCall = {
  id: "toolu_memory",
  name: "remember",
  arguments: { title: "Fact", content: "body" },
};
const askCall: ToolCall = {
  id: "toolu_ask",
  name: "ask_user",
  arguments: {
    questions: [
      {
        question: "Which?",
        header: "Pick",
        options: [
          { label: "A", description: "a" },
          { label: "B", description: "b" },
        ],
        multiSelect: false,
      },
    ],
  },
};

describe("plugin tool loop effect boundaries", () => {
  const cases = [
    {
      family: "vault op",
      call: writeCall,
      boundary: "vault_op_review",
      run: (
        guard: Parameters<typeof resolveVaultOps>[0]["guard"],
        live: LiveVaultReview,
      ) =>
        resolveVaultOps({
          vaultOpCalls: [writeCall],
          priorVaultOpCalls: [],
          round: 0,
          stopReason: "tool_use",
          context: { app, liveReview: live },
          callbacks: callbacks(),
          guard,
        }),
    },
    {
      family: "edit",
      call: editCall,
      boundary: "edit_review",
      run: (
        guard: Parameters<typeof resolveEdits>[0]["guard"],
        live: LiveVaultReview,
      ) =>
        resolveEdits({
          editCalls: [editCall],
          vaultOpContext: { app, liveReview: live },
          editContext: undefined,
          round: 0,
          callbacks: callbacks(),
          guard,
        }),
    },
    {
      family: "memory mutation",
      call: memoryCall,
      boundary: "memory_review",
      run: (
        guard: Parameters<typeof resolveMemories>[0]["guard"],
        live: LiveVaultReview,
      ) =>
        resolveMemories({
          memoryCalls: [memoryCall],
          context: undefined,
          liveReview: live,
          round: 0,
          callbacks: callbacks(),
          guard,
        }),
    },
  ];

  for (const { family, call, boundary, run } of cases) {
    it(`records a durable ${family} intent before its review runs`, async () => {
      const audit = recorder();
      const reviewed = review();
      const order: string[] = [];
      const guard = {
        crossEffectBoundary: async (
          crossedBoundary: string,
          request: EffectIntentRequest,
        ) => {
          order.push(`intent:${crossedBoundary}`);
          await audit.port.recordIntent(request, {
            leaseId: "turn-1#1",
            attemptOrdinal: 1,
          });
          return true;
        },
      };

      const [resolved] = await run(guard, reviewed.live);

      expect(order).toEqual([`intent:${boundary}`]);
      expect(reviewed.seen).toEqual([call.name]);
      expect(resolved.result.isError ?? false).toBe(false);
      expect(audit.recorded[0]).toMatchObject({
        family: family === "vault op" ? "vault_op" : family === "edit" ? "edit" : "memory",
        targetId: family === "memory mutation" ? "Fact" : "Notes/target.md",
        correlation: { kind: "provider_id", toolCallId: call.id },
      });
    });

    it(`refuses the ${family} without reaching its review when the intent is refused`, async () => {
      const reviewed = review();
      const guard = { crossEffectBoundary: () => Promise.resolve(false) };

      const [resolved] = await run(guard, reviewed.live);

      expect(reviewed.seen).toEqual([]);
      expect(resolved.result.isError).toBe(true);
      expect(resolved.result.content).toContain(boundary.replace(/_/g, " "));
    });
  }
});

describe("plugin tool loop boundary wiring", () => {
  /**
   * The wiring test phase 5 learned to write: a guard the loop never builds from
   * the recorder it was handed would leave every case above passing against a
   * seam that production does not have.
   */
  function client(toolCalls: ToolCall[]): ChatClient {
    let round = 0;
    return {
      complete: vi.fn(),
      stream: (): AssistantStreamRun<AssistantStreamEvent> => {
        const index = round++;
        const segmentId = `segment-${index}`;
        const calls = index === 0 ? toolCalls : [];
        const events = (async function* (): AsyncGenerator<AssistantStreamEvent> {
          yield { type: "segment_start", segmentId };
          for (const [position, toolCall] of calls.entries()) {
            const declarationKey = `${segmentId}-tool-${position}`;
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
          if (calls.length === 0) {
            yield { type: "prose_delta", segmentId, delta: "done" };
          }
          yield { type: "segment_end", segmentId };
          yield {
            type: "turn_end",
            status: calls.length > 0 ? "streaming" : "completed",
          };
        })();
        return ownedRunFromLegacy({
          events,
          usage: Promise.resolve(null),
          stopReason: Promise.resolve(calls.length > 0 ? "tool_use" : "end_turn"),
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
      },
    } as unknown as ChatClient;
  }

  it("does not open the interaction when its intent cannot be made durable", async () => {
    const audit = recorder({ fail: new Error("disk full") });
    const asked = vi.fn();
    const steps: Array<{ toolName: string; askStatus?: string }> = [];

    await runToolLoop(
      client([askCall]),
      { messages: [] } as unknown as ChatRequest,
      "test-model",
      "lmstudio",
      {} as never,
      new AbortController().signal,
      {
        onDelta: vi.fn(),
        onStepRecorded: (step) =>
          steps.push({ toolName: step.toolName ?? "", askStatus: step.askStatus }),
      },
      5,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      { ask: asked, cancelPending: vi.fn() } as unknown as AskUserResponder,
      undefined,
      undefined,
      undefined,
      audit.port,
    );

    // An answered question cannot be un-asked, so the interaction is a named
    // boundary too: no durable intent, no question.
    expect(audit.recorded[0]).toMatchObject({ family: "interaction" });
    expect(asked).not.toHaveBeenCalled();
    expect(steps).toEqual([
      expect.objectContaining({ toolName: "ask_user", askStatus: "cancelled" }),
    ]);
  });

  it("refuses the loop's own mutation when the audit store fails", async () => {
    const audit = recorder({ fail: new Error("disk full") });
    const reviewed = review();
    const results: Array<{ toolCallId: string; content: string }> = [];

    await runToolLoop(
      client([writeCall]),
      { messages: [] } as unknown as ChatRequest,
      "test-model",
      "lmstudio",
      {} as never,
      new AbortController().signal,
      {
        onDelta: vi.fn(),
        onStepResult: (toolCallId, result) =>
          results.push({ toolCallId, content: result.content }),
      },
      5,
      true,
      undefined,
      undefined,
      { app, liveReview: reviewed.live },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      audit.port,
    );

    expect(audit.recorded).toHaveLength(1);
    // The store write failed, so the mutation never reached the review.
    expect(reviewed.seen).toEqual([]);
    expect(results[0]?.content).toContain("vault op review");
  });
});

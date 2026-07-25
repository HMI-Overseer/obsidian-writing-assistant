import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { Memory } from "../../../../src/shared/types";
import { MemoryService } from "../../../../src/memory/MemoryService";
import type { ToolCall } from "../../../../src/tools/types";
import type { VaultOpPolicy } from "../../../../src/vault-ops/gateway";

const captured = vi.hoisted(() => ({
  callbacks: null as null | {
    onApprove: (proposalId: string) => Promise<void>;
    onDecline: (proposalId: string) => void;
  },
  proposals: [] as Array<{
    id: string;
    status: string;
    mutation: { kind: string };
  }>,
}));

vi.mock("../../../../src/chat/messages/memoryReviewTimeline", () => ({
  MemoryReviewTimelineView: class {
    constructor(opts: {
      callbacks: typeof captured.callbacks;
      proposals: typeof captured.proposals;
    }) {
      captured.callbacks = opts.callbacks;
      captured.proposals = opts.proposals;
    }
  },
}));

vi.mock("../../../../src/chat/messages/vaultReviewTimeline", () => ({
  VaultReviewTimelineView: class {},
}));

vi.mock("../../../../src/chat/messages/editReviewTimeline", () => ({
  EditReviewTimelineView: class {
    destroy() {}
  },
}));

import { LiveVaultReview } from "../../../../src/chat/actions/liveVaultReview";

const POLICY = (memory: VaultOpPolicy["memory"]): VaultOpPolicy => ({
  create: "ask",
  overwrite: "ask",
  move: "ask",
  trash: "ask",
  createDir: "ask",
  edit: "ask",
  memory,
  scopes: [],
  maxAutoOps: 20,
});

function addCall(id = "add-1"): ToolCall {
  return {
    id,
    name: "add_memory",
    arguments: {
      name: "vault-tone",
      type: "context",
      description: "Tone guide, recall when writing scene mood.",
      content: "Keep the atmosphere restrained and uncanny.",
    },
  };
}

function forgetCall(name = "vault-tone"): ToolCall {
  return {
    id: "forget-1",
    name: "forget_memory",
    arguments: { name },
  };
}

function harness(
  policy: VaultOpPolicy,
  posture: "ask" | "auto",
  initial: Memory[] = [],
) {
  const memories = initial.map((memory) => ({ ...memory }));
  const memoryService = new MemoryService(() => memories);
  const saveSettings = vi.fn(async () => undefined);
  const review = new LiveVaultReview({
    app: {} as App,
    timelineEl: {} as HTMLElement,
    policy,
    posture,
    memory: {
      memoryService,
      getMemories: () => memories,
      saveSettings,
    },
  });
  return { review, memories, memoryService, saveSettings };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  captured.callbacks = null;
  captured.proposals = [];
});

describe("LiveVaultReview memory channel", () => {
  it("still asks when vault posture is auto but policy.memory is ask", async () => {
    const { review, memories } = harness(POLICY("ask"), "auto");
    const pending = review.resolveMemories([addCall()]);
    await flush();

    expect(memories).toEqual([]);
    expect(captured.proposals).toHaveLength(1);
    expect(captured.proposals[0].status).toBe("pending");

    await captured.callbacks?.onApprove(captured.proposals[0].id);
    const [{ result }] = await pending;
    expect(result.disposition).toBe("applied");
    expect(memories.map((memory) => memory.name)).toEqual(["vault-tone"]);
  });

  it("auto-applies only when the separate memory gate is auto", async () => {
    const { review, memories, saveSettings } = harness(POLICY("auto"), "ask");
    const [{ result }] = await review.resolveMemories([addCall()]);

    expect(result.disposition).toBe("auto-applied");
    expect(memories.map((memory) => memory.name)).toEqual(["vault-tone"]);
    expect(saveSettings).toHaveBeenCalledOnce();
  });

  it("denies a memory mutation even when vault posture is auto", async () => {
    const { review, memories, saveSettings } = harness(POLICY("deny"), "auto");
    const [{ result }] = await review.resolveMemories([addCall()]);

    expect(result.isError).toBe(true);
    expect(result.failure?.kind).toBe("denied");
    expect(memories).toEqual([]);
    expect(saveSettings).not.toHaveBeenCalled();
    expect(captured.proposals).toEqual([]);
  });

  it("returns declined without mutating when the proposal is rejected", async () => {
    const { review, memories } = harness(POLICY("ask"), "ask");
    const pending = review.resolveMemories([addCall()]);
    await flush();

    captured.callbacks?.onDecline(captured.proposals[0].id);
    const [{ result }] = await pending;
    expect(result.disposition).toBe("declined");
    expect(result.isError).toBeFalsy();
    expect(memories).toEqual([]);
  });

  it("cancels and permanently discards a parked proposal", async () => {
    const { review, memories, saveSettings } = harness(POLICY("ask"), "ask");
    const pending = review.resolveMemories([addCall()]);
    await flush();
    expect(captured.proposals).toHaveLength(1);

    review.cancelPending();
    const [{ result }] = await pending;

    expect(result.disposition).toBe("cancelled");
    expect(result.content).toContain("cancelled and discarded");
    expect(memories).toEqual([]);
    expect(saveSettings).not.toHaveBeenCalled();
    expect(captured.proposals).toEqual([]);
  });

  it("rolls back an approved proposal when saveSettings fails", async () => {
    const { review, memories, saveSettings } = harness(POLICY("ask"), "ask");
    saveSettings.mockRejectedValueOnce(new Error("disk full"));
    const pending = review.resolveMemories([addCall()]);
    await flush();

    await captured.callbacks?.onApprove(captured.proposals[0].id);
    const [{ result }] = await pending;
    expect(result.disposition).toBe("failed");
    expect(result.failure?.kind).toBe("failed");
    expect(memories).toEqual([]);
  });

  it("dispatches one Claude Code mutation through resolveMemoryOne", async () => {
    const existing: Memory = {
      name: "vault-tone",
      type: "context",
      description: "Tone guide, recall when writing scene mood.",
      enabled: true,
    };
    const { review, memories } = harness(POLICY("auto"), "auto", [existing]);

    const result = await review.resolveMemoryOne(forgetCall(), "mcp-call-1");

    expect(result.disposition).toBe("auto-applied");
    expect(memories).toEqual([]);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { Memory } from "../../../../src/shared/types";
import { MemoryService } from "../../../../src/memory/MemoryService";
import type { ToolCall } from "../../../../src/tools/types";
import {
  applyToolAllowGuard,
  capRoundToMutation,
  classifyToolCalls,
  resolveMemories,
} from "../../../../src/chat/actions/toolLoop";
import { applyApprovedMemoryMutation } from "../../../../src/tools/memory/handlers";

function call(id: string, name: string, arguments_: Record<string, unknown> = {}): ToolCall {
  return { id, name, arguments: arguments_ };
}

function memoryContext(memories: Memory[] = []) {
  return {
    memoryService: new MemoryService(() => memories),
    getMemories: () => memories,
    saveSettings: vi.fn(async () => undefined),
  };
}

describe("memory tool-loop routing", () => {
  it("classifies recall as a read and add and forget as memory mutations", () => {
    const recall = call("r", "recall_memory", { names: ["vault-tone"] });
    const add = call("a", "add_memory");
    const forget = call("f", "forget_memory");
    const classified = classifyToolCalls([recall, add, forget]);

    expect(classified.loopCalls).toEqual([recall, add, forget]);
    expect(classified.unknownCalls).toEqual([]);
    expect(classified.memoryReadCalls).toEqual([recall]);
    expect(classified.memoryMutationCalls).toEqual([add, forget]);
  });

  it("caps and drains memory mutations one at a time while keeping leading reads", () => {
    const recall = call("r", "recall_memory", { names: ["vault-tone"] });
    const add = call("a", "add_memory");
    const forget = call("f", "forget_memory");

    expect(capRoundToMutation([recall, add, forget])).toEqual([recall, add]);
    expect(capRoundToMutation([forget, add])).toEqual([forget]);
  });

  it("refuses a denied memory mutation through the normal runtime allow guard", () => {
    const add = call("a", "add_memory");
    const guarded = applyToolAllowGuard([add], ["recall_memory"]);

    expect(guarded.blockedIds.has("a")).toBe(true);
    expect(guarded.blockedResults[0].result.failure?.kind).toBe("precondition");
    expect(guarded.blockedResults[0].result.isReadOnly).toBe(false);
  });

  it("records memory mutation steps before delegating to live review", async () => {
    const add = call("a", "add_memory", {
      name: "vault-tone",
      type: "context",
      description: "Tone guide, recall when writing scene mood.",
    });
    const result = {
      content: 'Added memory "vault-tone".',
      isReadOnly: false,
      disposition: "applied" as const,
    };
    const liveReview = {
      resolveMemories: vi.fn(async () => [{ tc: add, result }]),
    };
    const onStepRecorded = vi.fn();

    const resolved = await resolveMemories({
      memoryCalls: [add],
      context: memoryContext(),
      liveReview: liveReview as never,
      round: 2,
      callbacks: { onDelta: vi.fn(), onStepRecorded },
    });

    expect(liveReview.resolveMemories).toHaveBeenCalledWith([add]);
    expect(onStepRecorded).toHaveBeenCalledWith(
      expect.objectContaining({
        round: 2,
        toolName: "add_memory",
        toolCallId: "a",
      }),
    );
    expect(resolved).toEqual([{ tc: add, result }]);
  });

  it("falls back to validate-only mutation handling when no live review exists", async () => {
    const add = call("a", "add_memory", {
      name: "vault-tone",
      type: "context",
      description: "Tone guide, recall when writing scene mood.",
    });

    const [resolved] = await resolveMemories({
      memoryCalls: [add],
      context: memoryContext(),
      round: 0,
      callbacks: { onDelta: vi.fn() },
    });

    expect(resolved.result.isError).toBeFalsy();
    expect(resolved.result.content).toContain("queued for review");
  });

  it("preserves pins on an approved add and invalidates only affected pins on forget", async () => {
    const memories: Memory[] = [
      {
        name: "existing",
        type: "rule",
        description: "Existing rule.",
        enabled: true,
      },
      {
        name: "forgotten",
        type: "rule",
        description: "Rule to retract.",
        enabled: true,
      },
    ];
    const context = memoryContext(memories);
    const containingBefore = context.memoryService.getPinnedIndex("contains");
    memories.splice(1, 1);
    const unaffectedBefore = context.memoryService.getPinnedIndex("unaffected");
    memories.push({
      name: "forgotten",
      type: "rule",
      description: "Rule to retract.",
      enabled: true,
    });
    const liveReview = {
      resolveMemories: async (calls: ToolCall[]) =>
        Promise.all(
          calls.map(async (tc) => ({
            tc,
            result: await applyApprovedMemoryMutation(tc, context, "applied"),
          })),
        ),
    };
    const callbacks = { onDelta: vi.fn() };
    const add = call("a", "add_memory", {
      name: "new-rule",
      type: "rule",
      description: "New rule.",
    });

    await resolveMemories({
      memoryCalls: [add],
      context,
      liveReview: liveReview as never,
      round: 0,
      callbacks,
    });
    expect(context.memoryService.getPinnedIndex("contains")).toBe(containingBefore);
    expect(context.memoryService.getPinnedIndex("unaffected")).toBe(unaffectedBefore);

    await resolveMemories({
      memoryCalls: [call("f", "forget_memory", { name: "forgotten" })],
      context,
      liveReview: liveReview as never,
      round: 1,
      callbacks,
    });
    expect(context.memoryService.getPinnedIndex("contains")).not.toBe(containingBefore);
    expect(context.memoryService.getPinnedIndex("contains")).not.toContain("forgotten");
    expect(context.memoryService.getPinnedIndex("unaffected")).toBe(unaffectedBefore);
  });
});

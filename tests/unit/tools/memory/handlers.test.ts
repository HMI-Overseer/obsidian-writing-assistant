import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Memory } from "../../../../src/shared/types";
import { MemoryService } from "../../../../src/memory/MemoryService";
import type { ToolCall } from "../../../../src/tools/types";
import {
  MEMORY_RECALL_MAX_NAMES,
  applyApprovedMemoryMutation,
  executeMemoryTool,
} from "../../../../src/tools/memory/handlers";

function call(name: string, arguments_: Record<string, unknown>): ToolCall {
  return { id: "call-1", name, arguments: arguments_ };
}

function record(
  name: string,
  overrides: Partial<Memory> = {},
): Memory {
  return {
    name,
    type: "context",
    description: `Context for ${name}, recall when relevant.`,
    content: `Body for ${name}.`,
    enabled: true,
    ...overrides,
  };
}

function harness(initial: Memory[]) {
  const memories = initial.map((memory) => ({ ...memory }));
  const memoryService = new MemoryService(() => memories);
  const saveSettings = vi.fn(async () => undefined);
  const context = {
    memoryService,
    getMemories: () => memories,
    saveSettings,
  };
  return { memories, memoryService, saveSettings, context };
}

interface ParsedRecall {
  results: Array<{
    name: string;
    status: "hit" | "not_found" | "disabled" | "oversized";
    memory?: Omit<Memory, "enabled">;
    message?: string;
  }>;
}

function parsed(content: string): ParsedRecall {
  return JSON.parse(content) as ParsedRecall;
}

describe("executeMemoryTool recall_memory", () => {
  it("returns current full records in request order, including a body-less rule", async () => {
    const { context } = harness([
      record("project-state"),
      record("past-tense", {
        type: "rule",
        description: "Write all narrative prose in past tense.",
        content: undefined,
      }),
    ]);

    const result = await executeMemoryTool(
      call("recall_memory", { names: ["past-tense", "project-state"] }),
      context,
    );

    expect(result.isReadOnly).toBe(true);
    expect(result.isError).toBeFalsy();
    expect(parsed(result.content).results).toEqual([
      {
        name: "past-tense",
        status: "hit",
        memory: {
          name: "past-tense",
          type: "rule",
          description: "Write all narrative prose in past tense.",
        },
      },
      {
        name: "project-state",
        status: "hit",
        memory: {
          name: "project-state",
          type: "context",
          description: "Context for project-state, recall when relevant.",
          content: "Body for project-state.",
        },
      },
    ]);
  });

  it("distinguishes not_found and disabled with actionable per-name messages", async () => {
    const { context } = harness([
      record("disabled-rule", { enabled: false }),
    ]);

    const result = await executeMemoryTool(
      call("recall_memory", { names: ["missing", "disabled-rule"] }),
      context,
    );
    const results = parsed(result.content).results;

    expect(results[0]).toMatchObject({ name: "missing", status: "not_found" });
    expect(results[0].message).toContain("not_found");
    expect(results[0].message).toContain("check the memory name");
    expect(results[1]).toMatchObject({ name: "disabled-rule", status: "disabled" });
    expect(results[1].message).toContain("disabled");
    expect(results[1].message).toContain("enable");
  });

  it("rejects missing, malformed, empty, and over-limit batches", async () => {
    const { context } = harness([]);
    const invalidArgs = [
      {},
      { names: "one" },
      { names: [] },
      { names: ["valid", 4] },
      { names: Array.from({ length: MEMORY_RECALL_MAX_NAMES + 1 }, (_, i) => `m-${i}`) },
    ];

    for (const args of invalidArgs) {
      const result = await executeMemoryTool(call("recall_memory", args), context);
      expect(result.isError).toBe(true);
      expect(result.failure?.kind).toBe("invalid-args");
      expect(result.content).toContain("names");
      expect(result.content).toContain("retry");
    }
  });

  it("caps aggregate output and marks each record that does not fit as oversized", async () => {
    const records = Array.from({ length: 8 }, (_, index) =>
      record(`large-${index}`, { content: String(index).repeat(4000) }),
    );
    const { context } = harness(records);

    const result = await executeMemoryTool(
      call("recall_memory", { names: records.map((memory) => memory.name) }),
      context,
    );
    const results = parsed(result.content).results;
    const hits = results.filter((item) => item.status === "hit");
    const oversized = results.filter((item) => item.status === "oversized");

    expect(hits.length).toBeGreaterThan(0);
    expect(oversized.length).toBeGreaterThan(0);
    expect(results).toHaveLength(records.length);
    for (const item of oversized) {
      expect(item.message).toContain("oversized");
      expect(item.message).toContain("smaller batch");
    }
  });
});

describe("memory mutation validation and persistence", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("validates add_memory and returns a review proposal acknowledgement", async () => {
    const { context } = harness([]);
    const result = await executeMemoryTool(
      call("add_memory", {
        name: "vault-tone",
        type: "context",
        description: "Vault tone guide, recall when writing scene mood.",
        content: "Keep the atmosphere restrained and uncanny.",
        rationale: "The user stated this preference.",
      }),
      context,
    );

    expect(result.isError).toBeFalsy();
    expect(result.isReadOnly).toBe(false);
    expect(result.content).toContain("vault-tone");
    expect(result.content).toContain("review");
  });

  it("returns named actionable add_memory validation failures", async () => {
    const { context } = harness([record("existing")]);
    const cases = [
      {
        args: { name: "Not Canonical", type: "rule", description: "Use it." },
        code: "name_invalid",
        correction: "not-canonical",
      },
      {
        args: { name: "existing", type: "rule", description: "Use it." },
        code: "name_exists",
        correction: "different name",
      },
      {
        args: { name: "new-rule", type: "rule", description: "line one\nline two" },
        code: "description_multiline",
        correction: "single line",
      },
      {
        args: { name: "new-rule", type: "rule", description: "x".repeat(201) },
        code: "description_too_long",
        correction: "200",
      },
      {
        args: {
          name: "new-rule",
          type: "context",
          description: "Recall when relevant.",
          content: "x".repeat(4001),
        },
        code: "content_too_long",
        correction: "4000",
      },
    ];

    for (const { args, code, correction } of cases) {
      const result = await executeMemoryTool(call("add_memory", args), context);
      expect(result.isError).toBe(true);
      expect(result.content).toContain(code);
      expect(result.content).toContain(correction);
    }
  });

  it("returns actionable forget_memory errors for invalid and missing names", async () => {
    const { context } = harness([]);
    const invalid = await executeMemoryTool(
      call("forget_memory", { name: "Not Canonical" }),
      context,
    );
    expect(invalid.failure?.kind).toBe("invalid-args");
    expect(invalid.content).toContain("name_invalid");
    expect(invalid.content).toContain("not-canonical");

    const missing = await executeMemoryTool(
      call("forget_memory", { name: "missing" }),
      context,
    );
    expect(missing.failure?.kind).toBe("not-found");
    expect(missing.content).toContain("not_found");
    expect(missing.content).toContain("recall_memory");
  });

  it("persists an approved add without invalidating existing pins", async () => {
    const { memories, memoryService, saveSettings, context } = harness([record("existing")]);
    const existingPin = memoryService.getPinnedIndex("conversation-a");
    const invalidateContaining = vi.spyOn(memoryService, "invalidatePinsContaining");
    const invalidateAll = vi.spyOn(memoryService, "invalidateAll");

    const result = await applyApprovedMemoryMutation(
      call("add_memory", {
        name: "new-rule",
        type: "rule",
        description: "Always keep the response concise.",
      }),
      context,
      "applied",
    );

    expect(result.disposition).toBe("applied");
    expect(memories.map((memory) => memory.name)).toEqual(["existing", "new-rule"]);
    expect(saveSettings).toHaveBeenCalledOnce();
    expect(invalidateContaining).not.toHaveBeenCalled();
    expect(invalidateAll).not.toHaveBeenCalled();
    expect(memoryService.getPinnedIndex("conversation-a")).toBe(existingPin);
  });

  it("invalidates only pins containing an approved forgotten name, after save", async () => {
    const { memories, memoryService, saveSettings, context } = harness([
      record("existing"),
      record("forgotten"),
    ]);
    const containingBefore = memoryService.getPinnedIndex("contains");
    memories.splice(1, 1);
    const unaffectedBefore = memoryService.getPinnedIndex("unaffected");
    memories.push(record("forgotten"));

    const invalidate = vi.spyOn(memoryService, "invalidatePinsContaining");
    const result = await applyApprovedMemoryMutation(
      call("forget_memory", { name: "forgotten", reason: "No longer applies." }),
      context,
      "applied",
    );

    expect(result.disposition).toBe("applied");
    expect(saveSettings).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith("forgotten");
    expect(saveSettings.mock.invocationCallOrder[0]).toBeLessThan(
      invalidate.mock.invocationCallOrder[0],
    );
    expect(memoryService.getPinnedIndex("contains")).not.toBe(containingBefore);
    expect(memoryService.getPinnedIndex("contains")).not.toContain("forgotten");
    expect(memoryService.getPinnedIndex("unaffected")).toBe(unaffectedBefore);
  });

  it("rolls back a failed add save and leaves recall and pins unchanged", async () => {
    const { memories, memoryService, saveSettings, context } = harness([record("existing")]);
    const before = memoryService.getPinnedIndex("conversation-a");
    saveSettings.mockRejectedValueOnce(new Error("disk full"));
    const invalidate = vi.spyOn(memoryService, "invalidatePinsContaining");

    const result = await applyApprovedMemoryMutation(
      call("add_memory", {
        name: "new-rule",
        type: "rule",
        description: "Always keep the response concise.",
      }),
      context,
      "applied",
    );

    expect(result.isError).toBe(true);
    expect(result.failure?.kind).toBe("failed");
    expect(result.content).toContain("persistence");
    expect(memories.map((memory) => memory.name)).toEqual(["existing"]);
    expect(memoryService.readRecords(["new-rule"])).toEqual([]);
    expect(memoryService.getPinnedIndex("conversation-a")).toBe(before);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("rolls back a failed forget save and leaves recall and pins unchanged", async () => {
    const { memories, memoryService, saveSettings, context } = harness([
      record("existing"),
      record("forgotten"),
    ]);
    const before = memoryService.getPinnedIndex("conversation-a");
    saveSettings.mockRejectedValueOnce(new Error("disk full"));
    const invalidate = vi.spyOn(memoryService, "invalidatePinsContaining");

    const result = await applyApprovedMemoryMutation(
      call("forget_memory", { name: "forgotten" }),
      context,
      "applied",
    );

    expect(result.isError).toBe(true);
    expect(result.failure?.kind).toBe("failed");
    expect(result.content).toContain("persistence");
    expect(memories.map((memory) => memory.name)).toEqual(["existing", "forgotten"]);
    expect(memoryService.readRecords(["forgotten"])).toHaveLength(1);
    expect(memoryService.getPinnedIndex("conversation-a")).toBe(before);
    expect(invalidate).not.toHaveBeenCalled();
  });
});

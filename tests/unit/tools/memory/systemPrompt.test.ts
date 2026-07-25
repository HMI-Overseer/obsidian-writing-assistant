import { describe, expect, it } from "vitest";
import {
  ADD_MEMORY_TOOL,
  ALL_MEMORY_TOOLS,
  RECALL_MEMORY_TOOL,
} from "../../../../src/tools/memory/definition";
import { buildMemoryToolSystemPrompt } from "../../../../src/tools/memory/systemPrompt";

describe("buildMemoryToolSystemPrompt", () => {
  it("derives strategy and named error guidance from the active definitions", () => {
    const prompt = buildMemoryToolSystemPrompt(ALL_MEMORY_TOOLS);
    for (const tool of ALL_MEMORY_TOOLS) {
      expect(prompt).toContain(tool.name);
      expect(prompt).toContain(tool.strategyHint);
      expect(prompt).toContain(tool.errorGuidance);
    }
    expect(prompt).toContain("governing instructions");
  });

  it("describes only tools present on the active surface", () => {
    const prompt = buildMemoryToolSystemPrompt([
      RECALL_MEMORY_TOOL,
      ADD_MEMORY_TOOL,
    ]);
    expect(prompt).toContain("recall_memory");
    expect(prompt).toContain("add_memory");
    expect(prompt).not.toContain("\n- forget_memory,");
    expect(prompt).not.toContain("\n- forget_memory:");
  });
});

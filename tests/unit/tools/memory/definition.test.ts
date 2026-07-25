import { describe, expect, it } from "vitest";
import {
  ADD_MEMORY_TOOL,
  ALL_MEMORY_TOOLS,
  FORGET_MEMORY_TOOL,
  MEMORY_MUTATION_TOOL_NAMES,
  MEMORY_TOOL_NAMES,
  RECALL_MEMORY_TOOL,
  allowedMemoryTools,
  resolveMemoryGate,
} from "../../../../src/tools/memory/definition";
import { DEFAULT_VAULT_OP_POLICY } from "../../../../src/vault-ops/gateway";

const names = (tools: { name: string }[]): string[] => tools.map((tool) => tool.name);

describe("memory tool definitions", () => {
  it("exports the complete family and mutation name set", () => {
    expect(names(ALL_MEMORY_TOOLS)).toEqual([
      "recall_memory",
      "add_memory",
      "forget_memory",
    ]);
    expect([...MEMORY_TOOL_NAMES]).toEqual(names(ALL_MEMORY_TOOLS));
    expect([...MEMORY_MUTATION_TOOL_NAMES]).toEqual(["add_memory", "forget_memory"]);
  });

  it("defines the recall batch as a required string array", () => {
    expect(RECALL_MEMORY_TOOL.parameters.required).toEqual(["names"]);
    expect(RECALL_MEMORY_TOOL.parameters.properties.names).toMatchObject({
      type: "array",
      items: { type: "string" },
    });
    expect(RECALL_MEMORY_TOOL.annotations?.readOnlyHint).toBe(true);
  });

  it("defines add and forget schemas without path-normalization argument keys", () => {
    expect(ADD_MEMORY_TOOL.parameters.required).toEqual([
      "name",
      "type",
      "description",
    ]);
    expect(ADD_MEMORY_TOOL.parameters.properties.type.enum).toEqual(["rule", "context"]);
    expect(FORGET_MEMORY_TOOL.parameters.required).toEqual(["name"]);

    for (const tool of [ADD_MEMORY_TOOL, RECALL_MEMORY_TOOL, FORGET_MEMORY_TOOL]) {
      expect(Object.keys(tool.parameters.properties)).not.toEqual(
        expect.arrayContaining(["path", "from", "to", "paths"]),
      );
    }
  });

  it("carries strategy hints and actionable named error guidance", () => {
    for (const tool of ALL_MEMORY_TOOLS) {
      expect(tool.strategyHint).toBeTruthy();
      expect(tool.errorGuidance).toBeTruthy();
    }
    expect(RECALL_MEMORY_TOOL.strategyHint).toContain("when");
    expect(RECALL_MEMORY_TOOL.errorGuidance).toContain("not_found");
    expect(RECALL_MEMORY_TOOL.errorGuidance).toContain("disabled");
    expect(RECALL_MEMORY_TOOL.errorGuidance).toContain("oversized");
    expect(ADD_MEMORY_TOOL.strategyHint).toContain("before");
    expect(ADD_MEMORY_TOOL.errorGuidance).toContain("name_exists");
    expect(ADD_MEMORY_TOOL.errorGuidance).toContain("description_too_long");
  });
});

describe("memory policy gate", () => {
  it("resolves policy.memory under the default ask posture", () => {
    for (const memory of ["ask", "auto", "deny"] as const) {
      expect(resolveMemoryGate({ ...DEFAULT_VAULT_OP_POLICY, memory }, "ask")).toBe(memory);
    }
  });

  // Memory is an ordinary gate class, so the session posture wins first and
  // overrules the per-class value, deny included, as it does for every class.
  it("resolves auto under the auto posture whatever the class says", () => {
    for (const memory of ["ask", "auto", "deny"] as const) {
      expect(resolveMemoryGate({ ...DEFAULT_VAULT_OP_POLICY, memory }, "auto")).toBe("auto");
    }
  });

  it("keeps recall but hides mutations when memory writes are denied", () => {
    const denied = allowedMemoryTools({ ...DEFAULT_VAULT_OP_POLICY, memory: "deny" }, "ask");
    expect(names(denied)).toEqual(["recall_memory"]);
  });

  it("offers all three tools when memory writes are ask or auto", () => {
    for (const memory of ["ask", "auto"] as const) {
      expect(names(allowedMemoryTools({ ...DEFAULT_VAULT_OP_POLICY, memory }, "ask"))).toEqual(
        names(ALL_MEMORY_TOOLS),
      );
    }
  });

  it("re-offers denied mutations under the auto posture", () => {
    expect(
      names(allowedMemoryTools({ ...DEFAULT_VAULT_OP_POLICY, memory: "deny" }, "auto")),
    ).toEqual(names(ALL_MEMORY_TOOLS));
  });
});

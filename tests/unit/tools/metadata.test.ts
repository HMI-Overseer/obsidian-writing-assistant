import { describe, test, expect } from "vitest";
import {
  extractToolInput,
  isMutatingTool,
  MUTATING_TOOL_NAMES,
  TOOL_ICONS,
  TOOL_LABELS,
  TOOL_STATUS_LABELS,
} from "../../../src/tools/metadata";
import { VAULT_TOOL_NAMES } from "../../../src/tools/vault/definition";
import { EDIT_TOOL_NAMES } from "../../../src/tools/editing/definition";
import { VAULT_OPS_TOOL_NAMES } from "../../../src/tools/vault-ops/definition";
import {
  MEMORY_MUTATION_TOOL_NAMES,
  MEMORY_TOOL_NAMES,
} from "../../../src/tools/memory/definition";

describe("isMutatingTool", () => {
  test("every vault-op, edit, and memory mutation tool is classified as mutating", () => {
    for (const name of [
      ...VAULT_OPS_TOOL_NAMES,
      ...EDIT_TOOL_NAMES,
      ...MEMORY_MUTATION_TOOL_NAMES,
    ]) {
      expect(isMutatingTool(name)).toBe(true);
    }
  });

  test("read-only vault tools are not mutating", () => {
    for (const name of VAULT_TOOL_NAMES) {
      expect(isMutatingTool(name)).toBe(false);
    }
    expect(isMutatingTool("recall_memory")).toBe(false);
  });

  // Drift guard: if a new vault-op / edit tool is added, it must be classified here
  // too, or its timeline step would render as a read-only (cyan) call.
  test("the mutating set is exactly the vault-op, edit, and memory mutation tools", () => {
    expect([...MUTATING_TOOL_NAMES].sort()).toEqual(
      [
        ...VAULT_OPS_TOOL_NAMES,
        ...EDIT_TOOL_NAMES,
        ...MEMORY_MUTATION_TOOL_NAMES,
      ].sort(),
    );
  });

  test("undefined and unknown tools are not mutating", () => {
    expect(isMutatingTool(undefined)).toBe(false);
    expect(isMutatingTool("think")).toBe(false);
    expect(isMutatingTool("nonexistent_tool")).toBe(false);
  });
});

describe("display-metadata coverage", () => {
  // Every tool the timeline can render: vault ops + edit tools + read tools. Unlike
  // MUTATING_TOOL_NAMES, the four display maps below are hand-maintained, so a new
  // tool must be added to each by hand. These drift guards fail loudly when it isn't
  // (the gap that left move_folder / trash_folder showing a raw tool name and the
  // generic wrench icon; docs/review/reviews 2026-07-08-edit-tool-review-display F3).
  const ALL_TOOL_NAMES = [
    ...VAULT_OPS_TOOL_NAMES,
    ...EDIT_TOOL_NAMES,
    ...VAULT_TOOL_NAMES,
    ...MEMORY_TOOL_NAMES,
  ];

  // A single args object carrying every key any tool reads, so extractToolInput
  // returns a value for a covered tool and undefined only for an unhandled one.
  const KITCHEN_SINK_ARGS: Record<string, unknown> = {
    query: "q",
    path: "Notes/A.md",
    headingPath: "Section",
    pattern: "*.md",
    tag: "lore",
    paths: ["Notes/A.md"],
    explanation: "why",
    from: "Notes/A.md",
    to: "Notes/B.md",
    search: "old",
    replace: "new",
    text: "content",
    where: "append",
    anchor: "line",
    thought: "hmm",
    name: "vault-tone",
    names: ["vault-tone"],
    description: "Tone guide",
    content: "Restrained and uncanny",
  };

  test("TOOL_ICONS covers every tool", () => {
    for (const name of ALL_TOOL_NAMES) {
      expect(TOOL_ICONS[name], `TOOL_ICONS missing "${name}"`).toBeDefined();
    }
  });

  test("TOOL_LABELS covers every tool", () => {
    for (const name of ALL_TOOL_NAMES) {
      expect(TOOL_LABELS[name], `TOOL_LABELS missing "${name}"`).toBeDefined();
    }
  });

  test("TOOL_STATUS_LABELS covers every tool", () => {
    for (const name of ALL_TOOL_NAMES) {
      expect(TOOL_STATUS_LABELS[name], `TOOL_STATUS_LABELS missing "${name}"`).toBeDefined();
    }
  });

  test("extractToolInput returns a detail for every tool", () => {
    for (const name of ALL_TOOL_NAMES) {
      const input = extractToolInput({ name, arguments: KITCHEN_SINK_ARGS });
      expect(input, `extractToolInput has no case for "${name}"`).toBeDefined();
    }
  });
});

import { describe, test, expect } from "vitest";
import {
  extractToolInput,
  isMutatingTool,
  MUTATING_TOOL_NAMES,
  TOOL_ICONS,
  TOOL_LABELS,
  TOOL_NAME_BY_OP_KIND,
  TOOL_PENDING_LABELS,
  TOOL_STATUS_LABELS,
  opKindIcon,
  pendingToolLabel,
} from "../../../src/tools/metadata";
import { VAULT_TOOL_NAMES } from "../../../src/tools/vault/definition";
import { EDIT_TOOL_NAMES } from "../../../src/tools/editing/definition";
import { VAULT_OPS_TOOL_NAMES } from "../../../src/tools/vault-ops/definition";
import {
  MEMORY_MUTATION_TOOL_NAMES,
  MEMORY_TOOL_NAMES,
} from "../../../src/tools/memory/definition";
import { ASK_TOOL_NAMES } from "../../../src/tools/ask/definition";

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
    expect(isMutatingTool("ask_user")).toBe(false);
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
    ...ASK_TOOL_NAMES,
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
    where: "append",
    anchor: "line",
    thought: "hmm",
    name: "vault-tone",
    names: ["vault-tone"],
    description: "Tone guide",
    content: "Restrained and uncanny",
    questions: [{ question: "Which format?" }],
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

  test("uses the blocking pending label for ask_user", () => {
    expect(pendingToolLabel("ask_user")).toBe("Waiting for your answer");
  });

  // TOOL_PENDING_LABELS is the one display map with a *silent* fallback: a missing key
  // falls through to the past-tense TOOL_LABELS, so a pending write row reads "Trashed
  // file" next to its own approve button rather than "Trash file". That is exactly the
  // F4 defect the map was added to fix, and nothing else catches its regression.
  test("TOOL_PENDING_LABELS covers every mutating tool, in the present tense", () => {
    for (const name of [
      ...VAULT_OPS_TOOL_NAMES,
      ...MEMORY_MUTATION_TOOL_NAMES,
    ]) {
      const pending = TOOL_PENDING_LABELS[name];
      expect(pending, `TOOL_PENDING_LABELS missing "${name}"`).toBeDefined();
      // A present-tense label must not be the past-tense one; the fallback would have
      // produced exactly that, so this is what distinguishes a real entry from a gap.
      expect(pending, `TOOL_PENDING_LABELS["${name}"] repeats the past-tense label`).not.toBe(
        TOOL_LABELS[name],
      );
    }
  });

  // The edit tools are deliberately exempt: their past-tense labels already phrase
  // themselves as proposals ("Proposed edit"), so they read correctly while pending.
  test("the edit tools carry no pending label, and read correctly without one", () => {
    for (const name of EDIT_TOOL_NAMES) {
      expect(TOOL_PENDING_LABELS[name]).toBeUndefined();
      expect(pendingToolLabel(name)).toBe(TOOL_LABELS[name]);
    }
  });
});

describe("operation-kind display metadata", () => {
  // Keys are typechecked against VaultOperation["kind"]; the values are tool-name
  // strings nothing checks. A rename that misses one leaves a historical vault-op row
  // labelling itself from a tool that no longer exists, which degrades to a raw string.
  test("every TOOL_NAME_BY_OP_KIND value is an advertised vault-op tool", () => {
    for (const [kind, toolName] of Object.entries(TOOL_NAME_BY_OP_KIND)) {
      expect(
        VAULT_OPS_TOOL_NAMES.has(toolName),
        `TOOL_NAME_BY_OP_KIND["${kind}"] names "${toolName}", which is not a vault-op tool`,
      ).toBe(true);
    }
  });

  test("every op kind resolves to a label and an icon through its tool", () => {
    for (const kind of Object.keys(TOOL_NAME_BY_OP_KIND) as Array<
      keyof typeof TOOL_NAME_BY_OP_KIND
    >) {
      expect(TOOL_LABELS[TOOL_NAME_BY_OP_KIND[kind]], `no label for kind "${kind}"`).toBeDefined();
      expect(opKindIcon(kind), `no icon for kind "${kind}"`).toBeDefined();
    }
  });
});

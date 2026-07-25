import { describe, it, expect, vi } from "vitest";
import type { Memory } from "../../../src/shared/types";
import type { Gate, VaultOpPolicy } from "../../../src/vault-ops/gateway";
import { DEFAULT_VAULT_OP_POLICY } from "../../../src/vault-ops/gateway";
import {
  applyMemoryMutation,
  commitMemoryGate,
  commitMemoryFeatureToggle,
  commitMemoryMutation,
  memoryInvalidationFor,
  memoryValidationMessage,
  validateMemoryForm,
} from "../../../src/memory/settingsEdits";
import type { MemoryMutation } from "../../../src/memory/settingsEdits";

function memory(name: string, overrides: Partial<Memory> = {}): Memory {
  return {
    name,
    type: "rule",
    description: `Description for ${name}.`,
    enabled: true,
    ...overrides,
  };
}

const STORE: Memory[] = [
  memory("no-emdashes"),
  memory("pov-limited", { enabled: false }),
  memory("vault-tone", { type: "context", content: "Grimdark." }),
];

/** A store bag whose settings side is a plain array, plus recorded invalidations. */
function createStore(save: () => Promise<void> = async () => undefined) {
  const state = { memories: STORE.map((record) => ({ ...record })) };
  const saveMock = vi.fn(save);
  const invalidateAll = vi.fn();
  const invalidatePinsContaining = vi.fn();
  return {
    state,
    saveMock,
    invalidateAll,
    invalidatePinsContaining,
    access: {
      getMemories: () => state.memories,
      setMemories: (next: Memory[]) => {
        state.memories = next;
      },
      save: saveMock,
      invalidateAll,
      invalidatePinsContaining,
    },
  };
}

// ── Modal validation ────────────────────────────────────────────────────────

describe("validateMemoryForm", () => {
  it("accepts a well formed new record", () => {
    const result = validateMemoryForm(
      { name: "past-tense", type: "rule", description: "Write in past tense." },
      STORE,
      null,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe("past-tense");
  });

  it("rejects a new record colliding with a stored name, case-insensitively", () => {
    const result = validateMemoryForm(
      { name: "no-emdashes", type: "rule", description: "Duplicate." },
      STORE,
      null,
    );
    expect(result).toEqual({
      ok: false,
      issue: { code: "name_exists", colliding: "no-emdashes" },
    });
  });

  it("lets an edit keep its own name", () => {
    const result = validateMemoryForm(
      { name: "no-emdashes", type: "rule", description: "Revised wording." },
      STORE,
      "no-emdashes",
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a rename onto another stored name", () => {
    const result = validateMemoryForm(
      { name: "vault-tone", type: "rule", description: "Renamed onto a sibling." },
      STORE,
      "no-emdashes",
    );
    expect(result).toEqual({
      ok: false,
      issue: { code: "name_exists", colliding: "vault-tone" },
    });
  });

  it("still enforces the Phase 1 structural rules", () => {
    const invalidName = validateMemoryForm(
      { name: "Not Kebab", type: "rule", description: "x" },
      STORE,
      null,
    );
    expect(invalidName).toEqual({
      ok: false,
      issue: { code: "name_invalid", normalized: "not-kebab" },
    });

    const emptyDescription = validateMemoryForm(
      { name: "fresh", type: "rule", description: "   " },
      STORE,
      null,
    );
    expect(emptyDescription).toEqual({ ok: false, issue: { code: "description_empty" } });

    const multiline = validateMemoryForm(
      { name: "fresh", type: "rule", description: "one\ntwo" },
      STORE,
      null,
    );
    expect(multiline).toEqual({ ok: false, issue: { code: "description_multiline" } });

    const longDescription = validateMemoryForm(
      { name: "fresh", type: "rule", description: "d".repeat(201) },
      STORE,
      null,
    );
    expect(longDescription).toEqual({
      ok: false,
      issue: { code: "description_too_long", limit: 200, actual: 201 },
    });

    const longContent = validateMemoryForm(
      { name: "fresh", type: "context", description: "Fine.", content: "c".repeat(4001) },
      STORE,
      null,
    );
    expect(longContent).toEqual({
      ok: false,
      issue: { code: "content_too_long", limit: 4000, actual: 4001 },
    });
  });
});

describe("memoryValidationMessage", () => {
  it("suggests the normalized form when one survives normalization", () => {
    expect(memoryValidationMessage({ code: "name_invalid", normalized: "not-kebab" })).toContain(
      "not-kebab",
    );
  });

  it("omits a suggestion when nothing survives normalization", () => {
    const message = memoryValidationMessage({ code: "name_invalid", normalized: "" });
    expect(message).not.toContain('Try "');
    expect(message.length).toBeGreaterThan(0);
  });

  it("names the colliding memory", () => {
    expect(memoryValidationMessage({ code: "name_exists", colliding: "no-emdashes" })).toContain(
      "no-emdashes",
    );
  });

  it("carries the limit and the actual length on both length rejections", () => {
    const description = memoryValidationMessage({
      code: "description_too_long",
      limit: 200,
      actual: 240,
    });
    expect(description).toContain("240");
    expect(description).toContain("200");

    const content = memoryValidationMessage({ code: "content_too_long", limit: 4000, actual: 4200 });
    expect(content).toContain("4200");
    expect(content).toContain("4000");
  });

  // Written as a code point so this file never carries a literal one.
  const EM_DASH = String.fromCodePoint(0x2014);

  it("produces a non-empty sentence for every named issue", () => {
    const issues = [
      { code: "name_invalid", normalized: "x" },
      { code: "name_exists", colliding: "x" },
      { code: "type_invalid" },
      { code: "description_empty" },
      { code: "description_multiline" },
      { code: "description_too_long", limit: 200, actual: 201 },
      { code: "content_invalid" },
      { code: "content_too_long", limit: 4000, actual: 4001 },
    ] as const;
    for (const issue of issues) {
      const message = memoryValidationMessage(issue);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain(EM_DASH);
    }
  });
});

// ── Pure list transforms ────────────────────────────────────────────────────

describe("applyMemoryMutation", () => {
  it("appends an added record without touching the rest", () => {
    const added = memory("past-tense");
    const next = applyMemoryMutation(STORE, { kind: "add", memory: added });
    expect(next).toHaveLength(4);
    expect(next[3]).toEqual(added);
    expect(next.slice(0, 3)).toEqual(STORE);
  });

  it("replaces an edited record in place, preserving its position and switch", () => {
    const next = applyMemoryMutation(STORE, {
      kind: "edit",
      previousName: "pov-limited",
      memory: { name: "pov-close", type: "rule", description: "Renamed.", enabled: false },
    });
    expect(next.map((record) => record.name)).toEqual([
      "no-emdashes",
      "pov-close",
      "vault-tone",
    ]);
    expect(next[1].enabled).toBe(false);
  });

  it("leaves the list untouched when the edited record is already gone", () => {
    const next = applyMemoryMutation(STORE, {
      kind: "edit",
      previousName: "never-stored",
      memory: memory("never-stored"),
    });
    expect(next).toEqual(STORE);
  });

  it("removes a deleted record", () => {
    const next = applyMemoryMutation(STORE, { kind: "delete", name: "vault-tone" });
    expect(next.map((record) => record.name)).toEqual(["no-emdashes", "pov-limited"]);
  });

  it("flips only the targeted record's switch", () => {
    const enabled = applyMemoryMutation(STORE, { kind: "enable", name: "pov-limited" });
    expect(enabled.map((record) => record.enabled)).toEqual([true, true, true]);

    const disabled = applyMemoryMutation(STORE, { kind: "disable", name: "no-emdashes" });
    expect(disabled.map((record) => record.enabled)).toEqual([false, false, true]);
  });

  it("never mutates the input list", () => {
    const source = STORE.map((record) => ({ ...record }));
    applyMemoryMutation(source, { kind: "delete", name: "no-emdashes" });
    applyMemoryMutation(source, { kind: "disable", name: "no-emdashes" });
    expect(source).toEqual(STORE);
  });
});

describe("memoryInvalidationFor", () => {
  it("clears every pin for an add and for enabling a disabled entry", () => {
    expect(memoryInvalidationFor({ kind: "add", memory: memory("x") })).toEqual({ scope: "all" });
    expect(memoryInvalidationFor({ kind: "enable", name: "pov-limited" })).toEqual({ scope: "all" });
  });

  it("targets the affected name for an edit, a disable, and a delete", () => {
    expect(
      memoryInvalidationFor({
        kind: "edit",
        previousName: "pov-limited",
        memory: memory("pov-close"),
      }),
    ).toEqual({ scope: "containing", name: "pov-limited" });
    expect(memoryInvalidationFor({ kind: "disable", name: "no-emdashes" })).toEqual({
      scope: "containing",
      name: "no-emdashes",
    });
    expect(memoryInvalidationFor({ kind: "delete", name: "vault-tone" })).toEqual({
      scope: "containing",
      name: "vault-tone",
    });
  });
});

// ── Persistence and invalidation ordering ───────────────────────────────────

describe("commitMemoryMutation", () => {
  const cases: ReadonlyArray<{
    label: string;
    mutation: MemoryMutation;
    expectAll: boolean;
    expectName?: string;
  }> = [
    { label: "add", mutation: { kind: "add", memory: memory("past-tense") }, expectAll: true },
    { label: "enable", mutation: { kind: "enable", name: "pov-limited" }, expectAll: true },
    {
      label: "edit",
      mutation: {
        kind: "edit",
        previousName: "no-emdashes",
        memory: memory("no-emdashes", { description: "Revised." }),
      },
      expectAll: false,
      expectName: "no-emdashes",
    },
    {
      label: "disable",
      mutation: { kind: "disable", name: "no-emdashes" },
      expectAll: false,
      expectName: "no-emdashes",
    },
    {
      label: "delete",
      mutation: { kind: "delete", name: "vault-tone" },
      expectAll: false,
      expectName: "vault-tone",
    },
  ];

  for (const testCase of cases) {
    it(`persists before invalidating for a ${testCase.label}`, async () => {
      const order: string[] = [];
      const store = createStore(async () => {
        order.push("save");
      });
      store.invalidateAll.mockImplementation(() => order.push("invalidateAll"));
      store.invalidatePinsContaining.mockImplementation((name: string) =>
        order.push(`invalidatePinsContaining:${name}`),
      );

      await commitMemoryMutation(store.access, testCase.mutation);

      expect(store.saveMock).toHaveBeenCalledTimes(1);
      if (testCase.expectAll) {
        expect(order).toEqual(["save", "invalidateAll"]);
        expect(store.invalidatePinsContaining).not.toHaveBeenCalled();
      } else {
        expect(order).toEqual(["save", `invalidatePinsContaining:${testCase.expectName}`]);
        expect(store.invalidateAll).not.toHaveBeenCalled();
      }
    });

    it(`restores the pre-change store and invalidates nothing when a ${testCase.label} fails to persist`, async () => {
      const store = createStore(async () => {
        throw new Error("disk full");
      });
      const before = store.state.memories.map((record) => ({ ...record }));

      await expect(commitMemoryMutation(store.access, testCase.mutation)).rejects.toThrow(
        "disk full",
      );

      expect(store.state.memories).toEqual(before);
      expect(store.invalidateAll).not.toHaveBeenCalled();
      expect(store.invalidatePinsContaining).not.toHaveBeenCalled();
    });
  }

  it("writes the mutated list into settings before saving", async () => {
    let seenDuringSave: string[] = [];
    const store = createStore(async () => {
      seenDuringSave = store.state.memories.map((record) => record.name);
    });

    await commitMemoryMutation(store.access, { kind: "delete", name: "no-emdashes" });

    expect(seenDuringSave).toEqual(["pov-limited", "vault-tone"]);
    expect(store.state.memories.map((record) => record.name)).toEqual([
      "pov-limited",
      "vault-tone",
    ]);
  });
});

describe("commitMemoryFeatureToggle", () => {
  function createFeature(initial: boolean, failing = false) {
    const state = { enabled: initial };
    const order: string[] = [];
    const invalidateAll = vi.fn(() => order.push("invalidateAll"));
    return {
      state,
      order,
      invalidateAll,
      access: {
        getEnabled: () => state.enabled,
        setEnabled: (value: boolean) => {
          state.enabled = value;
        },
        save: vi.fn(async () => {
          if (failing) throw new Error("disk full");
          order.push("save");
        }),
        invalidateAll,
      },
    };
  }

  it("persists the flip, then clears every pin", async () => {
    const feature = createFeature(false);
    await commitMemoryFeatureToggle(feature.access, true);
    expect(feature.state.enabled).toBe(true);
    expect(feature.order).toEqual(["save", "invalidateAll"]);
  });

  it("clears every pin when switching the feature off too", async () => {
    const feature = createFeature(true);
    await commitMemoryFeatureToggle(feature.access, false);
    expect(feature.state.enabled).toBe(false);
    expect(feature.order).toEqual(["save", "invalidateAll"]);
  });

  it("rolls the flag back and invalidates nothing when persistence fails", async () => {
    const feature = createFeature(false, true);

    await expect(commitMemoryFeatureToggle(feature.access, true)).rejects.toThrow("disk full");

    expect(feature.state.enabled).toBe(false);
    expect(feature.invalidateAll).not.toHaveBeenCalled();
  });
});

describe("commitMemoryGate", () => {
  function createPolicy(failing = false) {
    const policy: VaultOpPolicy = {
      ...DEFAULT_VAULT_OP_POLICY,
      scopes: [...DEFAULT_VAULT_OP_POLICY.scopes],
    };
    return {
      policy,
      access: {
        getGate: () => policy.memory,
        setGate: (gate: Gate) => {
          policy.memory = gate;
        },
        save: vi.fn(async () => {
          if (failing) throw new Error("disk full");
        }),
      },
    };
  }

  it("writes the chosen gate onto policy.memory and nothing else", async () => {
    const { policy, access } = createPolicy();
    await commitMemoryGate(access, "auto");
    expect(policy.memory).toBe("auto");
    expect({ ...policy, memory: DEFAULT_VAULT_OP_POLICY.memory }).toEqual({
      ...DEFAULT_VAULT_OP_POLICY,
      scopes: [...DEFAULT_VAULT_OP_POLICY.scopes],
    });
  });

  it("reaches all three positions, deny included", async () => {
    const { policy, access } = createPolicy();
    for (const gate of ["auto", "deny", "ask"] as const) {
      await commitMemoryGate(access, gate);
      expect(policy.memory).toBe(gate);
    }
  });

  it("restores the previous gate when persistence fails", async () => {
    const { policy, access } = createPolicy(true);
    policy.memory = "auto";

    await expect(commitMemoryGate(access, "deny")).rejects.toThrow("disk full");

    expect(policy.memory).toBe("auto");
  });
});

import { describe, it, expect, vi } from "vitest";
import type { Memory } from "../../../../src/shared/types";
import {
  createMemoriesSectionCallbacks,
  formatMemoriesStatus,
  syncMemoriesSection,
} from "../../../../src/chat/composer/memoriesSection";
import type { MemoriesSnapshot } from "../../../../src/chat/composer/memoriesSection";

function memory(name: string, enabled: boolean): Memory {
  return { name, type: "rule", description: `Description for ${name}.`, enabled };
}

function snapshot(overrides: Partial<MemoriesSnapshot> = {}): MemoriesSnapshot {
  return { enabled: true, enabledCount: 2, totalCount: 5, indexTokens: 180, ...overrides };
}

describe("formatMemoriesStatus", () => {
  it("reports the enabled count, the total, and the index estimate", () => {
    expect(formatMemoriesStatus(snapshot())).toBe("2 enabled of 5, ~180 tokens");
  });

  it("abbreviates a large index estimate", () => {
    expect(formatMemoriesStatus(snapshot({ indexTokens: 1_200 }))).toBe(
      "2 enabled of 5, ~1.2k tokens",
    );
  });

  it("omits the token figure while the feature is off, because no index is delivered", () => {
    expect(formatMemoriesStatus(snapshot({ enabled: false }))).toBe("Off, 2 enabled of 5");
  });

  it("says so plainly when nothing is stored", () => {
    expect(formatMemoriesStatus(snapshot({ enabledCount: 0, totalCount: 0, indexTokens: 0 }))).toBe(
      "No memories yet",
    );
    expect(
      formatMemoriesStatus(
        snapshot({ enabled: false, enabledCount: 0, totalCount: 0, indexTokens: 0 }),
      ),
    ).toBe("No memories yet");
  });

  it("reports an enabled feature with every entry switched off", () => {
    expect(formatMemoriesStatus(snapshot({ enabledCount: 0, indexTokens: 0 }))).toBe(
      "0 enabled of 5, ~0 tokens",
    );
  });
});

describe("syncMemoriesSection", () => {
  function refs() {
    return {
      toggle: { setValue: vi.fn() },
      statusEl: { textContent: null as string | null },
    };
  }

  it("pushes the snapshot into the toggle and the status line", () => {
    const section = refs();
    syncMemoriesSection(section, snapshot());
    expect(section.toggle.setValue).toHaveBeenCalledWith(true);
    expect(section.statusEl.textContent).toBe("2 enabled of 5, ~180 tokens");
  });

  it("follows the feature switch back off", () => {
    const section = refs();
    syncMemoriesSection(section, snapshot({ enabled: false }));
    expect(section.toggle.setValue).toHaveBeenCalledWith(false);
    expect(section.statusEl.textContent).toBe("Off, 2 enabled of 5");
  });
});

describe("createMemoriesSectionCallbacks", () => {
  function createDeps(memories: Memory[], memoriesEnabled: boolean, failing = false) {
    const settings = { memoriesEnabled, memories };
    const order: string[] = [];
    const invalidateAll = vi.fn(() => order.push("invalidateAll"));
    const estimateIndexTokens = vi.fn(() => 240);
    const saveSettings = vi.fn(async () => {
      if (failing) throw new Error("disk full");
      order.push("save");
    });
    const service = { invalidateAll, estimateIndexTokens };
    return {
      settings,
      order,
      invalidateAll,
      estimateIndexTokens,
      saveSettings,
      callbacks: createMemoriesSectionCallbacks({
        getSettings: () => settings,
        saveSettings,
        getMemoryService: () => service,
      }),
    };
  }

  it("counts enabled records against the total and reads the live token estimate", () => {
    const deps = createDeps(
      [memory("a", true), memory("b", false), memory("c", true)],
      true,
    );

    expect(deps.callbacks.getMemoriesSnapshot()).toEqual({
      enabled: true,
      enabledCount: 2,
      totalCount: 3,
      indexTokens: 240,
    });
    expect(deps.estimateIndexTokens).toHaveBeenCalledTimes(1);
  });

  it("re-reads the store on every snapshot, so a tab edit shows up immediately", () => {
    const deps = createDeps([memory("a", true)], true);
    expect(deps.callbacks.getMemoriesSnapshot().totalCount).toBe(1);

    deps.settings.memories.push(memory("b", false));
    expect(deps.callbacks.getMemoriesSnapshot()).toMatchObject({
      enabledCount: 1,
      totalCount: 2,
    });
  });

  it("mutates the setting, persists it, then clears every pin", async () => {
    const deps = createDeps([memory("a", true)], false);

    await deps.callbacks.onMemoriesToggle(true);

    expect(deps.settings.memoriesEnabled).toBe(true);
    expect(deps.order).toEqual(["save", "invalidateAll"]);
  });

  it("clears every pin when the feature is switched off too", async () => {
    const deps = createDeps([memory("a", true)], true);

    await deps.callbacks.onMemoriesToggle(false);

    expect(deps.settings.memoriesEnabled).toBe(false);
    expect(deps.order).toEqual(["save", "invalidateAll"]);
  });

  it("rolls the setting back and invalidates nothing when persistence fails", async () => {
    const deps = createDeps([memory("a", true)], false, true);

    await expect(deps.callbacks.onMemoriesToggle(true)).rejects.toThrow("disk full");

    expect(deps.settings.memoriesEnabled).toBe(false);
    expect(deps.invalidateAll).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import type { Memory } from "../../../src/shared/types";
import { estimateStringTokens } from "../../../src/shared/tokenEstimation";
import { MemoryService } from "../../../src/memory/MemoryService";
import { renderMemoryIndex } from "../../../src/memory/indexRender";

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    name: "alpha",
    type: "rule",
    description: "Alpha rule.",
    enabled: true,
    ...overrides,
  };
}

describe("MemoryService", () => {
  it("pins exact index bytes on first access and ignores later store changes", () => {
    const records = [memory()];
    const service = new MemoryService(() => records);

    const first = service.getPinnedIndex("conversation-1");
    records[0] = memory({ description: "Changed rule." });

    expect(service.getPinnedIndex("conversation-1")).toBe(first);
  });

  it("invalidates only pins that contained the targeted name", () => {
    const records = [memory()];
    const service = new MemoryService(() => records);
    const beforeAdd = service.getPinnedIndex("before-add");

    records.push(memory({ name: "beta", description: "Beta rule." }));
    const afterAdd = service.getPinnedIndex("after-add");
    expect(afterAdd).toContain('"name":"beta"');

    records.splice(
      0,
      records.length,
      memory({ description: "Updated alpha rule." }),
    );
    service.invalidatePinsContaining("BETA");

    expect(service.getPinnedIndex("before-add")).toBe(beforeAdd);
    expect(service.getPinnedIndex("after-add")).toContain("Updated alpha rule.");
    expect(service.getPinnedIndex("after-add")).not.toContain('"name":"beta"');
  });

  it("invalidates every pin when requested", () => {
    const records = [memory()];
    const service = new MemoryService(() => records);
    const first = service.getPinnedIndex("conversation-1");

    records[0] = memory({ description: "Changed rule." });
    service.invalidateAll();

    expect(service.getPinnedIndex("conversation-1")).not.toBe(first);
    expect(service.getPinnedIndex("conversation-1")).toContain("Changed rule.");
  });

  it("reads requested records from the current store, including disabled records", () => {
    const records = [memory()];
    const service = new MemoryService(() => records);
    service.getPinnedIndex("conversation-1");

    records.push(
      memory({
        name: "beta",
        type: "context",
        description: "Beta context.",
        content: "Current body.",
        enabled: false,
      }),
    );

    expect(service.readRecords(["BETA", "missing", "alpha"])).toEqual([
      records[1],
      records[0],
    ]);
  });

  it("estimates the current rendered index rather than pinned bytes", () => {
    const records = [memory()];
    const service = new MemoryService(() => records);
    service.getPinnedIndex("conversation-1");
    records.push(memory({ name: "beta", description: "Beta rule." }));

    expect(service.estimateIndexTokens()).toBe(
      estimateStringTokens(renderMemoryIndex(records)),
    );
  });

  it("drops all runtime pins when destroyed", () => {
    const records = [memory()];
    const service = new MemoryService(() => records);
    const first = service.getPinnedIndex("conversation-1");

    records[0] = memory({ description: "Changed rule." });
    service.destroy();

    expect(service.getPinnedIndex("conversation-1")).not.toBe(first);
    expect(service.getPinnedIndex("conversation-1")).toContain("Changed rule.");
  });
});

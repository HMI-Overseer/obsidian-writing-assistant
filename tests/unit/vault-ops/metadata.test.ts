import { describe, it, expect } from "vitest";
import type { App } from "obsidian";
import { backlinkCount } from "../../../src/vault-ops/metadata";

/** Minimal app exposing only what backlinkCount touches. */
function makeApp(
  files: Record<string, { path: string }>,
  backlinks: Record<string, { data: Record<string, unknown[]> } | null | undefined>,
): App {
  return {
    vault: {
      getFileByPath: (p: string) => files[p] ?? null,
    },
    metadataCache: {
      getBacklinksForFile: (file: { path: string }) => backlinks[file.path],
    },
  } as unknown as App;
}

describe("backlinkCount", () => {
  it("returns 0 for an unknown path (no file)", () => {
    const app = makeApp({}, {});
    expect(backlinkCount(app, "missing.md")).toBe(0);
  });

  it("counts the keys of the file's backlink data", () => {
    const file = { path: "alice.md" };
    const app = makeApp(
      { "alice.md": file },
      { "alice.md": { data: { "a.md": [], "b.md": [], "c.md": [] } } },
    );
    expect(backlinkCount(app, "alice.md")).toBe(3);
  });

  it("returns 0 when the file has no incoming links", () => {
    const file = { path: "alice.md" };
    const app = makeApp({ "alice.md": file }, { "alice.md": { data: {} } });
    expect(backlinkCount(app, "alice.md")).toBe(0);
  });

  it("returns 0 (not a throw) when getBacklinksForFile yields no object", () => {
    // The `?.data ?? {}` guard is load-bearing: Obsidian's undocumented method can
    // return null/undefined, and an un-guarded `.data` would throw here.
    const file = { path: "alice.md" };
    const app = makeApp({ "alice.md": file }, { "alice.md": null });
    expect(backlinkCount(app, "alice.md")).toBe(0);
  });
});

import { describe, it, expect } from "vitest";
import type { App } from "obsidian";
import { applyHunksLive, undoHunkLive } from "../../../src/editing/documentApplicator";
import { resolveEdits, buildHunks } from "../../../src/editing/diffEngine";
import type { DiffHunk, EditBlock } from "../../../src/editing/editTypes";

/** Minimal in-memory vault backing the apply/undo paths (mirrors EditReviewController.test). */
function makeApp(initial: string) {
  const state = { content: initial };
  const file = { path: "note.md" };
  const vault = {
    getFileByPath: (path: string) => (path === "note.md" ? file : null),
    process: async (_file: unknown, fn: (c: string) => string) => {
      state.content = fn(state.content);
      return state.content;
    },
    read: async () => state.content,
  };
  return { app: { vault } as unknown as App, state };
}

function hunksFor(
  doc: string,
  edits: { search: string; replace: string }[],
): DiffHunk[] {
  const blocks: EditBlock[] = edits.map((e, i) => ({
    id: `b${i}`,
    searchText: e.search,
    replaceText: e.replace,
    rawBlock: "",
  }));
  const resolved = resolveEdits(blocks, doc, { contextLines: 2, minConfidence: 0.7 });
  return buildHunks(resolved);
}

/** Count of CRLF vs lone-LF newlines, to assert no mixed endings slipped through. */
function endingCounts(text: string) {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  return { crlf, loneLf: lf - crlf };
}

describe("applyHunksLive, end-of-line handling (P1-2)", () => {
  it("applies an LF-resolved hunk to a CRLF document and keeps it pure CRLF", async () => {
    const doc = "Line one.\r\nLine two.\r\nLine three.";
    const hunks = hunksFor(doc, [{ search: "Line one.\nLine two.", replace: "Line one.\nLine TWO." }]);
    const { app, state } = makeApp(doc);

    const result = await applyHunksLive(app, "note.md", hunks);

    expect(result.appliedHunkIds).toHaveLength(1);
    expect(state.content).toBe("Line one.\r\nLine TWO.\r\nLine three.");
    // No mixed endings: every newline is a CRLF, none lone.
    expect(endingCounts(state.content).loneLf).toBe(0);
    expect(state.content).not.toMatch(/\r\r/); // and no \r\r\n from double-expansion
  });

  it("leaves an LF document LF-only (no \\r introduced)", async () => {
    const doc = "Line one.\nLine two.\nLine three.";
    const hunks = hunksFor(doc, [{ search: "Line one.\nLine two.", replace: "Line one.\nLine TWO." }]);
    const { app, state } = makeApp(doc);

    await applyHunksLive(app, "note.md", hunks);

    expect(state.content).toBe("Line one.\nLine TWO.\nLine three.");
    expect(state.content).not.toContain("\r");
  });

  it("round-trips accept then undo on a CRLF document back to the original bytes", async () => {
    const doc = "Line one.\r\nLine two.\r\nLine three.";
    const hunks = hunksFor(doc, [{ search: "Line one.\nLine two.", replace: "Line one.\nLine TWO." }]);
    const { app, state } = makeApp(doc);

    const applied = await applyHunksLive(app, "note.md", hunks);
    const trackedOffset = applied.appliedOffsets.get(hunks[0].id);
    const undone = await undoHunkLive(app, "note.md", hunks[0], trackedOffset);

    expect(undone.undone).toBe(true);
    expect(state.content).toBe(doc);
  });
});

describe("applyHunksLive, multi-hunk descending splice (P1-16)", () => {
  it("applies every hunk in one process() pass without offset corruption", async () => {
    const doc = "Alpha ONE bravo TWO charlie THREE delta.";
    const hunks = hunksFor(doc, [
      { search: "ONE", replace: "ONE!" },
      { search: "TWO", replace: "TWO!" },
      { search: "THREE", replace: "THREE!" },
    ]);
    const { app, state } = makeApp(doc);

    const result = await applyHunksLive(app, "note.md", hunks);

    expect(result.appliedHunkIds).toHaveLength(3);
    expect(state.content).toBe("Alpha ONE! bravo TWO! charlie THREE! delta.");
  });

  it("descends so a large earlier insertion does not drift a later hunk past the guard", async () => {
    // A growth larger than MAX_OFFSET_DRIFT (500) on the FIRST region: applying
    // ascending would shift the later region's index by >500 and wrongly skip it.
    // Descending order applies the later hunk first (at its true offset, zero
    // drift), so both land.
    const grow = "x".repeat(600);
    const doc = "head MARKERONE body MARKERTWO tail.";
    const hunks = hunksFor(doc, [
      { search: "MARKERONE", replace: `MARKERONE ${grow}` },
      { search: "MARKERTWO", replace: "MARKERTWO!" },
    ]);
    const { app, state } = makeApp(doc);

    const result = await applyHunksLive(app, "note.md", hunks);

    expect(result.appliedHunkIds).toHaveLength(2);
    expect(state.content).toContain(`MARKERONE ${grow}`);
    expect(state.content).toContain("MARKERTWO!");
  });

  it("skips a hunk whose live position drifted beyond MAX_OFFSET_DRIFT", async () => {
    // Resolve against a short doc (SEARCHME near offset 0), then apply to a doc
    // where the SAME text sits >500 chars later. The match is present but the
    // drift guard refuses it to avoid editing the wrong place.
    const resolveDoc = "Hi SEARCHME there.";
    const hunks = hunksFor(resolveDoc, [{ search: "SEARCHME", replace: "FOUND" }]);
    const liveDoc = `${"y".repeat(600)} SEARCHME there.`;
    const { app, state } = makeApp(liveDoc);

    const result = await applyHunksLive(app, "note.md", hunks);

    expect(result.appliedHunkIds).toHaveLength(0);
    expect(state.content).toContain("SEARCHME"); // present, but skipped by the guard (not absent)
    expect(state.content).toBe(liveDoc);
  });
});

describe("undoHunkLive, re-anchoring fallbacks (P1-16)", () => {
  it("falls back to indexOf when no tracked offset is supplied", async () => {
    const doc = "Keep this LANDMARK in place.";
    const hunks = hunksFor(doc, [{ search: "LANDMARK", replace: "BEACON" }]);
    const { app, state } = makeApp(doc);

    await applyHunksLive(app, "note.md", hunks);
    expect(state.content).toContain("BEACON");

    const undone = await undoHunkLive(app, "note.md", hunks[0]); // no trackedOffset

    expect(undone.undone).toBe(true);
    expect(state.content).toBe(doc);
  });

  it("falls back to indexOf when the tracked offset no longer matches", async () => {
    const doc = "Keep this LANDMARK in place.";
    const hunks = hunksFor(doc, [{ search: "LANDMARK", replace: "BEACON" }]);
    const { app, state } = makeApp(doc);

    await applyHunksLive(app, "note.md", hunks);
    // A stale/garbage tracked offset whose slice is not the replacement text.
    const undone = await undoHunkLive(app, "note.md", hunks[0], 9999);

    expect(undone.undone).toBe(true);
    expect(state.content).toBe(doc);
  });

  it("reports undone:false and leaves the file untouched when the replacement is gone", async () => {
    const doc = "Keep this LANDMARK in place.";
    const hunks = hunksFor(doc, [{ search: "LANDMARK", replace: "BEACON" }]);
    // Apply was never run, so BEACON is nowhere in the live document.
    const { app, state } = makeApp(doc);

    const undone = await undoHunkLive(app, "note.md", hunks[0]);

    expect(undone.undone).toBe(false);
    expect(undone.restoredContent).toBeNull();
    expect(state.content).toBe(doc);
  });
});

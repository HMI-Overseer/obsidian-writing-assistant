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

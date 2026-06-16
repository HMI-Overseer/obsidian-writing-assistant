import { describe, it, expect, vi } from "vitest";
import type { App } from "obsidian";
import { InlineDiffManager } from "../../../src/editing/inlineDiff/InlineDiffManager";
import { setInlineHunks, clearInlineHunks } from "../../../src/editing/inlineDiff/inlineDiffState";
import { EditReviewController } from "../../../src/editing/EditReviewController";
import { resolveEdits, buildHunks } from "../../../src/editing/diffEngine";
import type { EditBlock, EditProposal } from "../../../src/editing/editTypes";

/** A stand-in for the CM6 EditorView — only `dispatch` is exercised. */
function fakeCm() {
  return { dispatch: vi.fn() };
}

/** A workspace whose active view is swappable between assertions. */
function makeWorkspace() {
  const ws = {
    activeView: null as unknown,
    getActiveViewOfType: vi.fn(() => ws.activeView),
    on: vi.fn(() => ({})),
  };
  return ws;
}

function makeController(doc: string, search: string, replace: string): EditReviewController {
  const stubApp = {
    vault: { getFileByPath: () => null, process: async () => undefined, read: async () => doc },
  } as unknown as App;
  const blocks: EditBlock[] = [{ id: "b0", searchText: search, replaceText: replace, rawBlock: "" }];
  const resolved = resolveEdits(blocks, doc, { contextLines: 2, minConfidence: 0.7 });
  const proposal: EditProposal = {
    id: "p1",
    targetFilePath: "note.md",
    documentSnapshot: doc,
    snapshotTimestamp: 0,
    hunks: buildHunks(resolved),
    prose: "",
  };
  return new EditReviewController(stubApp, proposal, {
    onHunksChanged: () => undefined,
    onApplied: () => undefined,
    onUndone: () => undefined,
  });
}

describe("InlineDiffManager — editor.cm extraction + dispatch", () => {
  it("dispatches the pending hunks into the active editor's view", () => {
    const cm = fakeCm();
    const ws = makeWorkspace();
    ws.activeView = { editor: { cm }, file: { path: "note.md" } };
    const manager = new InlineDiffManager({ workspace: ws } as unknown as App);

    manager.attach(makeController("The quick brown fox.", "quick", "slow"));

    expect(cm.dispatch).toHaveBeenCalledTimes(1);
    const effect = cm.dispatch.mock.calls[0][0].effects;
    expect(effect.is(setInlineHunks)).toBe(true);
    expect(effect.value).toHaveLength(1);
    expect(effect.value[0]).toMatchObject({ matchedText: "quick", replaceText: "slow" });
  });

  it("clears the overlay when the active file has no registered proposal", () => {
    const cm = fakeCm();
    const ws = makeWorkspace();
    ws.activeView = { editor: { cm }, file: { path: "other.md" } };
    const manager = new InlineDiffManager({ workspace: ws } as unknown as App);

    manager.attach(makeController("The quick brown fox.", "quick", "slow")); // targets note.md

    expect(cm.dispatch).toHaveBeenCalledTimes(1);
    expect(cm.dispatch.mock.calls[0][0].effects.is(clearInlineHunks)).toBe(true);
  });

  it("does not throw or dispatch when the active editor exposes no CodeMirror view", () => {
    const ws = makeWorkspace();
    ws.activeView = { editor: {}, file: { path: "note.md" } }; // guard: no `.cm`
    const manager = new InlineDiffManager({ workspace: ws } as unknown as App);

    expect(() => manager.attach(makeController("The quick brown fox.", "quick", "slow"))).not.toThrow();
  });

  it("does not throw when no markdown view is active", () => {
    const ws = makeWorkspace();
    ws.activeView = null; // guard: getActiveViewOfType returned nothing
    const manager = new InlineDiffManager({ workspace: ws } as unknown as App);

    expect(() => manager.attach(makeController("doc with target here", "target", "goal"))).not.toThrow();
  });

  it("clears the previously bound editor when switching to another note", () => {
    const cm = fakeCm();
    const ws = makeWorkspace();
    ws.activeView = { editor: { cm }, file: { path: "note.md" } };
    const manager = new InlineDiffManager({ workspace: ws } as unknown as App);
    manager.attach(makeController("The quick brown fox.", "quick", "slow"));
    cm.dispatch.mockClear();

    // User switches to a different note backed by its own editor view.
    const cm2 = fakeCm();
    ws.activeView = { editor: { cm: cm2 }, file: { path: "other.md" } };
    manager.refresh();

    expect(cm.dispatch).toHaveBeenCalledTimes(1);
    expect(cm.dispatch.mock.calls[0][0].effects.is(clearInlineHunks)).toBe(true);
    expect(cm2.dispatch.mock.calls[0][0].effects.is(clearInlineHunks)).toBe(true);
  });
});

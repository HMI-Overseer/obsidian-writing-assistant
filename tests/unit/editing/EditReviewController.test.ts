import { describe, it, expect, vi, beforeEach } from "vitest";
import type { App } from "obsidian";
import { Notice } from "obsidian";
import { EditReviewController, type EditReviewCallbacks } from "../../../src/editing/EditReviewController";
import { resolveEdits, buildHunks } from "../../../src/editing/diffEngine";
import type { AppliedEditRecord, EditBlock, EditProposal } from "../../../src/editing/editTypes";

// The overlap guard's only observable signal is the warning Notice, so replace the
// no-op mock class with a spyable constructor for this file.
vi.mock("obsidian", async (importOriginal) => {
  const actual = await importOriginal<typeof import("obsidian")>();
  return { ...actual, Notice: vi.fn() };
});

/** Minimal in-memory vault backing the apply/undo paths. */
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

function makeProposal(doc: string, edits: { search: string; replace: string }[]): EditProposal {
  const blocks: EditBlock[] = edits.map((e, i) => ({
    id: `b${i}`,
    searchText: e.search,
    replaceText: e.replace,
    rawBlock: "",
  }));
  const resolved = resolveEdits(blocks, doc, { contextLines: 2, minConfidence: 0.7 });
  return {
    id: "p1",
    targetFilePath: "note.md",
    documentSnapshot: doc,
    snapshotTimestamp: 0,
    hunks: buildHunks(resolved),
    prose: "",
  };
}

function makeCallbacks(): EditReviewCallbacks & {
  hunksChanged: ReturnType<typeof vi.fn>;
  applied: ReturnType<typeof vi.fn>;
  undone: ReturnType<typeof vi.fn>;
} {
  const hunksChanged = vi.fn();
  const applied = vi.fn();
  const undone = vi.fn();
  return {
    hunksChanged,
    applied,
    undone,
    onHunksChanged: hunksChanged,
    onApplied: applied,
    onUndone: undone,
  };
}

describe("EditReviewController", () => {
  beforeEach(() => {
    vi.mocked(Notice).mockClear();
  });

  it("accept applies the hunk to the document and records it", async () => {
    const { app, state } = makeApp("The quick brown fox.");
    const proposal = makeProposal("The quick brown fox.", [{ search: "quick", replace: "slow" }]);
    const cb = makeCallbacks();
    const controller = new EditReviewController(app, proposal, cb);

    await controller.accept(proposal.hunks[0].id);

    expect(state.content).toBe("The slow brown fox.");
    expect(controller.getStatus(proposal.hunks[0].id)).toBe("accepted");
    expect(cb.applied).toHaveBeenCalledTimes(1);
    expect(controller.hasPendingHunks()).toBe(false);
  });

  it("reject marks the hunk skipped without touching the document", () => {
    const { app, state } = makeApp("The quick brown fox.");
    const proposal = makeProposal("The quick brown fox.", [{ search: "quick", replace: "slow" }]);
    const cb = makeCallbacks();
    const controller = new EditReviewController(app, proposal, cb);

    controller.reject(proposal.hunks[0].id);

    expect(state.content).toBe("The quick brown fox.");
    expect(controller.getStatus(proposal.hunks[0].id)).toBe("rejected");
    expect(cb.hunksChanged).toHaveBeenCalledTimes(1);
    expect(cb.applied).not.toHaveBeenCalled();
  });

  it("undo reverses an accepted hunk and clears the applied record", async () => {
    const { app, state } = makeApp("The quick brown fox.");
    const proposal = makeProposal("The quick brown fox.", [{ search: "quick", replace: "slow" }]);
    const cb = makeCallbacks();
    const controller = new EditReviewController(app, proposal, cb);
    const id = proposal.hunks[0].id;

    await controller.accept(id);
    await controller.undo(id);

    expect(state.content).toBe("The quick brown fox.");
    expect(controller.getStatus(id)).toBe("pending");
    expect(cb.undone).toHaveBeenCalledTimes(1);
    expect(controller.hasPendingHunks()).toBe(true);
  });

  it("broadcasts every status change to all subscribers (panel + overlay sync)", async () => {
    const { app } = makeApp("The quick brown fox.");
    const proposal = makeProposal("The quick brown fox.", [{ search: "quick", replace: "slow" }]);
    const controller = new EditReviewController(app, proposal, makeCallbacks());
    const id = proposal.hunks[0].id;

    const panel = vi.fn();
    const overlay = vi.fn();
    controller.subscribe(panel);
    controller.subscribe(overlay);

    await controller.accept(id);

    expect(panel).toHaveBeenCalledWith({ hunkId: id, status: "accepted" });
    expect(overlay).toHaveBeenCalledWith({ hunkId: id, status: "accepted" });
  });

  it("unsubscribe stops further broadcasts", () => {
    const { app } = makeApp("doc with target here");
    const proposal = makeProposal("doc with target here", [{ search: "target", replace: "goal" }]);
    const controller = new EditReviewController(app, proposal, makeCallbacks());

    const listener = vi.fn();
    const off = controller.subscribe(listener);
    off();
    controller.reject(proposal.hunks[0].id);

    expect(listener).not.toHaveBeenCalled();
  });

  it("pendingHunks excludes unresolved (no-match) hunks", () => {
    const { app } = makeApp("only this line exists");
    const proposal = makeProposal("only this line exists", [
      { search: "this", replace: "that" },
      { search: "nonexistent phrase", replace: "x" },
    ]);
    const controller = new EditReviewController(app, proposal, makeCallbacks());

    expect(controller.pendingHunks()).toHaveLength(1);
  });

  it("initialHunkView reflects a restored applied record", () => {
    const { app } = makeApp("alpha beta gamma");
    const proposal = makeProposal("alpha beta gamma", [
      { search: "alpha", replace: "ALPHA" },
      { search: "gamma", replace: "GAMMA" },
    ]);
    const [first, second] = proposal.hunks;
    const record: AppliedEditRecord = {
      proposalId: proposal.id,
      targetFilePath: "note.md",
      preApplySnapshot: "alpha beta gamma",
      postApplySnapshot: "ALPHA beta gamma",
      appliedAt: 0,
      appliedHunkIds: [first.id],
    };
    const controller = new EditReviewController(app, proposal, makeCallbacks(), record);

    expect(controller.initialHunkView(first.id)).toBe("applied");
    expect(controller.initialHunkView(second.id)).toBe("skipped");
  });

  it("ignores accept on an already-resolved hunk", async () => {
    const { app, state } = makeApp("The quick brown fox.");
    const proposal = makeProposal("The quick brown fox.", [{ search: "quick", replace: "slow" }]);
    const controller = new EditReviewController(app, proposal, makeCallbacks());
    const id = proposal.hunks[0].id;

    await controller.accept(id);
    await controller.accept(id); // second accept is a no-op

    expect(state.content).toBe("The slow brown fox.");
  });

  it("blocks accepting a hunk that overlaps an already-applied one (P1-9)", async () => {
    // "quick brown" [4,15) and "brown fox" [10,19) share the "brown" span. Accepts apply
    // one-at-a-time to the live document and re-anchor by indexOf, so applying the second
    // over the first's rewritten region would silently no-op or re-anchor wrong. The
    // controller refuses it instead, with a warning notice.
    const doc = "The quick brown fox jumps.";
    const { app, state } = makeApp(doc);
    const proposal = makeProposal(doc, [
      { search: "quick brown", replace: "slow" },
      { search: "brown fox", replace: "red dog" },
    ]);
    const cb = makeCallbacks();
    const controller = new EditReviewController(app, proposal, cb);
    const [a, b] = proposal.hunks;

    await controller.accept(a.id);
    expect(state.content).toBe("The slow fox jumps.");

    await controller.accept(b.id);

    expect(Notice).toHaveBeenCalledWith(expect.stringContaining("overlaps"));
    expect(controller.getStatus(b.id)).toBe("pending");
    expect(state.content).toBe("The slow fox jumps."); // the refused accept changed nothing
    expect(cb.applied).toHaveBeenCalledTimes(1); // only the first hunk was applied
  });

  it("does not block accepts whose source regions are disjoint", async () => {
    const doc = "alpha beta gamma delta";
    const { app, state } = makeApp(doc);
    const proposal = makeProposal(doc, [
      { search: "alpha", replace: "ALPHA" },
      { search: "gamma", replace: "GAMMA" },
    ]);
    const controller = new EditReviewController(app, proposal, makeCallbacks());
    const [a, b] = proposal.hunks;

    await controller.accept(a.id);
    await controller.accept(b.id);

    expect(Notice).not.toHaveBeenCalled();
    expect(controller.getStatus(a.id)).toBe("accepted");
    expect(controller.getStatus(b.id)).toBe("accepted");
    expect(state.content).toBe("ALPHA beta GAMMA delta");
  });

  it("acceptAll applies every pending disjoint hunk in one pass", async () => {
    const doc = "alpha beta gamma delta";
    const { app, state } = makeApp(doc);
    const proposal = makeProposal(doc, [
      { search: "alpha", replace: "ALPHA" },
      { search: "gamma", replace: "GAMMA" },
    ]);
    const cb = makeCallbacks();
    const controller = new EditReviewController(app, proposal, cb);
    const [a, b] = proposal.hunks;

    await controller.acceptAll();

    expect(state.content).toBe("ALPHA beta GAMMA delta");
    expect(controller.getStatus(a.id)).toBe("accepted");
    expect(controller.getStatus(b.id)).toBe("accepted");
    expect(controller.hasPendingHunks()).toBe(false);
    // One applied-record update, one broadcast per hunk.
    expect(cb.applied).toHaveBeenCalledTimes(1);
  });

  it("acceptAll skips a hunk overlapping one already applied, applying the rest", async () => {
    const doc = "The quick brown fox jumps far.";
    const { app, state } = makeApp(doc);
    const proposal = makeProposal(doc, [
      { search: "quick brown", replace: "slow" },
      { search: "brown fox", replace: "red dog" }, // overlaps the first
      { search: "far", replace: "near" },
    ]);
    const controller = new EditReviewController(app, proposal, makeCallbacks());
    const [a, b, c] = proposal.hunks;

    await controller.acceptAll();

    expect(controller.getStatus(a.id)).toBe("accepted");
    expect(controller.getStatus(b.id)).toBe("pending"); // overlapped, left for manual review
    expect(controller.getStatus(c.id)).toBe("accepted");
    expect(state.content).toBe("The slow fox jumps near.");
  });

  it("acceptAll broadcasts each applied hunk to subscribers", async () => {
    const doc = "alpha beta gamma delta";
    const { app } = makeApp(doc);
    const proposal = makeProposal(doc, [
      { search: "alpha", replace: "ALPHA" },
      { search: "gamma", replace: "GAMMA" },
    ]);
    const controller = new EditReviewController(app, proposal, makeCallbacks());
    const [a, b] = proposal.hunks;
    const listener = vi.fn();
    controller.subscribe(listener);

    await controller.acceptAll();

    expect(listener).toHaveBeenCalledWith({ hunkId: a.id, status: "accepted" });
    expect(listener).toHaveBeenCalledWith({ hunkId: b.id, status: "accepted" });
  });

  it("rejectAll marks every pending hunk skipped without touching the document", () => {
    const doc = "alpha beta gamma delta";
    const { app, state } = makeApp(doc);
    const proposal = makeProposal(doc, [
      { search: "alpha", replace: "ALPHA" },
      { search: "gamma", replace: "GAMMA" },
    ]);
    const cb = makeCallbacks();
    const controller = new EditReviewController(app, proposal, cb);
    const [a, b] = proposal.hunks;

    controller.rejectAll();

    expect(state.content).toBe(doc);
    expect(controller.getStatus(a.id)).toBe("rejected");
    expect(controller.getStatus(b.id)).toBe("rejected");
    expect(controller.hasPendingHunks()).toBe(false);
    expect(cb.applied).not.toHaveBeenCalled();
    expect(cb.hunksChanged).toHaveBeenCalledTimes(1);
  });

  it("rejectAll leaves already-accepted hunks untouched", async () => {
    const doc = "alpha beta gamma delta";
    const { app, state } = makeApp(doc);
    const proposal = makeProposal(doc, [
      { search: "alpha", replace: "ALPHA" },
      { search: "gamma", replace: "GAMMA" },
    ]);
    const controller = new EditReviewController(app, proposal, makeCallbacks());
    const [a, b] = proposal.hunks;

    await controller.accept(a.id);
    controller.rejectAll();

    expect(controller.getStatus(a.id)).toBe("accepted");
    expect(controller.getStatus(b.id)).toBe("rejected");
    expect(state.content).toBe("ALPHA beta gamma delta");
  });

  it("re-allows an overlapping accept once the conflicting hunk is undone", async () => {
    const doc = "The quick brown fox jumps.";
    const { app, state } = makeApp(doc);
    const proposal = makeProposal(doc, [
      { search: "quick brown", replace: "slow" },
      { search: "brown fox", replace: "red dog" },
    ]);
    const controller = new EditReviewController(app, proposal, makeCallbacks());
    const [a, b] = proposal.hunks;

    await controller.accept(a.id);
    await controller.accept(b.id); // blocked while A is applied
    expect(controller.getStatus(b.id)).toBe("pending");

    await controller.undo(a.id); // frees the overlapping region
    await controller.accept(b.id);

    expect(controller.getStatus(b.id)).toBe("accepted");
    expect(state.content).toBe("The quick red dog jumps.");
  });
});

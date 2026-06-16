import { describe, it, expect, vi } from "vitest";
import type { App } from "obsidian";
import { EditReviewController, type EditReviewCallbacks } from "../../../src/editing/EditReviewController";
import { resolveEdits, buildHunks } from "../../../src/editing/diffEngine";
import type { AppliedEditRecord, EditBlock, EditProposal } from "../../../src/editing/editTypes";

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
});

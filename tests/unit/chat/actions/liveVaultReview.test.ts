import { describe, it, expect, vi, beforeEach } from "vitest";
import type { App } from "obsidian";
import { TFile, TFolder, normalizePath } from "obsidian";
import type { ToolCall } from "../../../../src/tools/types";
import type { VaultOpPolicy } from "../../../../src/vault-ops/gateway";

// Capture the review view's wiring without a real DOM: the test simulates clicks
// by invoking the captured `onOpResolved` callback.
const captured = vi.hoisted(() => ({
  callbacks: null as unknown as {
    onOpResolved?: (opId: string, disposition: "applied" | "declined") => void;
  } | null,
  proposalOps: [] as Array<{ id: string; status: string; gate: string }>,
}));

vi.mock("../../../../src/chat/messages/vaultReviewTimeline", () => ({
  VaultReviewTimelineView: class {
    constructor(opts: { callbacks: typeof captured.callbacks; proposal: { ops: typeof captured.proposalOps } }) {
      captured.callbacks = opts.callbacks;
      captured.proposalOps = opts.proposal.ops;
    }
  },
}));

vi.mock("../../../../src/vault-ops/applyBatch", () => ({
  applyVaultOpBatch: vi.fn(async (_app: unknown, batch: Array<{ id: string }>) => ({
    ok: true,
    conflicts: [],
    applied: batch.map((b) => ({
      opId: b.id,
      inverse: { kind: "trash", path: "x", expect: { mtime: 0, size: 0 }, snapshot: "" },
    })),
  })),
}));

import { LiveVaultReview } from "../../../../src/chat/actions/liveVaultReview";

function makeApp(existing: { files?: string[]; folders?: string[] } = {}): App {
  const files = new Set((existing.files ?? []).map(normalizePath));
  const folders = new Set((existing.folders ?? []).map(normalizePath));
  return {
    vault: {
      getAbstractFileByPath(p: string) {
        const n = normalizePath(p);
        if (files.has(n)) return Object.assign(new TFile(), { path: n });
        if (folders.has(n)) return Object.assign(new TFolder(), { path: n });
        return null;
      },
      getFileByPath(p: string) {
        const n = normalizePath(p);
        return files.has(n) ? Object.assign(new TFile(), { path: n, stat: { mtime: 1, size: 1 } }) : null;
      },
      read: () => Promise.resolve(""),
    },
    metadataCache: { getBacklinksForFile: () => ({ data: {} }) },
  } as unknown as App;
}

const POLICY = (overrides: Partial<VaultOpPolicy> = {}): VaultOpPolicy => ({
  create: "ask",
  overwrite: "ask",
  move: "ask",
  trash: "ask",
  createDir: "ask",
  edit: "ask",
  scopes: [],
  maxAutoOps: 20,
  ...overrides,
});

function writeCall(id: string, path: string): ToolCall {
  return { id, name: "write_file", arguments: { path, content: "hello" } };
}

const TIMELINE_EL = {} as unknown as HTMLElement;

/** Let the coordinator's async register/remount run before inspecting state. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  captured.callbacks = null;
  captured.proposalOps = [];
});

describe("LiveVaultReview", () => {
  it("auto-applies an auto-gated op and reports auto-applied without a click", async () => {
    const review = new LiveVaultReview({
      app: makeApp(),
      timelineEl: TIMELINE_EL,
      policy: POLICY({ create: "auto" }),
    });

    const [{ result }] = await review.resolveRound([writeCall("c1", "Notes/A.md")]);

    expect(result.content).toBe('Created "Notes/A.md" (auto-applied).');
    expect(result.isError).toBeFalsy();
    expect(review.getAppliedRecord()?.applied).toHaveLength(1);
    expect(review.getProposal()?.ops[0].status).toBe("applied");
  });

  it("suspends an ask-gated op until the user approves, then reports applied", async () => {
    const review = new LiveVaultReview({
      app: makeApp(),
      timelineEl: TIMELINE_EL,
      policy: POLICY({ create: "ask" }),
    });

    const pending = review.resolveRound([writeCall("c1", "Notes/A.md")]);
    await flush();
    // Not resolved yet — the op is parked on the user.
    expect(captured.proposalOps[0].status).toBe("pending");

    // Simulate the approve click reported by the timeline.
    const opId = captured.proposalOps[0].id;
    captured.callbacks?.onOpResolved?.(opId, "applied");

    const [{ result }] = await pending;
    expect(result.content).toBe('Created "Notes/A.md".');
  });

  it("reports declined when the user declines an ask-gated op", async () => {
    const review = new LiveVaultReview({
      app: makeApp(),
      timelineEl: TIMELINE_EL,
      policy: POLICY({ create: "ask" }),
    });

    const pending = review.resolveRound([writeCall("c1", "Notes/A.md")]);
    await flush();
    captured.callbacks?.onOpResolved?.(captured.proposalOps[0].id, "declined");

    const [{ result }] = await pending;
    expect(result.content).toBe('Declined by user — "Notes/A.md" was not changed.');
    expect(result.isError).toBeFalsy();
  });

  it("cancelPending resolves a parked op as cancelled (no hung await)", async () => {
    const review = new LiveVaultReview({
      app: makeApp(),
      timelineEl: TIMELINE_EL,
      policy: POLICY({ create: "ask" }),
    });

    const pending = review.resolveRound([writeCall("c1", "Notes/A.md")]);
    await flush();
    review.cancelPending();

    const [{ result }] = await pending;
    expect(result.content).toContain("still pending review");
  });

  it("reports a create_directory on an existing folder as satisfied, never applying it", async () => {
    const review = new LiveVaultReview({
      app: makeApp({ folders: ["Notes"] }),
      timelineEl: TIMELINE_EL,
      policy: POLICY(),
    });

    const [{ result }] = await review.resolveRound([
      { id: "d1", name: "create_directory", arguments: { path: "Notes" } },
    ]);

    expect(result.content).toBe('Folder "Notes" already exists; nothing to do.');
    expect(review.getAppliedRecord()).toBeNull();
  });

  it("resolveOne binds the op to the supplied tool-call id (Claude Code path)", async () => {
    const review = new LiveVaultReview({
      app: makeApp(),
      timelineEl: TIMELINE_EL,
      policy: POLICY({ create: "auto" }),
    });

    const result = await review.resolveOne(
      { id: "ignored", name: "write_file", arguments: { path: "Notes/B.md", content: "x" } },
      "mcp-tool-id",
    );

    expect(result.content).toBe('Created "Notes/B.md" (auto-applied).');
    expect(review.getProposal()?.ops[0].sourceToolCallId).toBe("mcp-tool-id");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { App } from "obsidian";
import { TFile, TFolder, normalizePath } from "obsidian";
import type { ToolCall } from "../../../../src/tools/types";
import type { VaultOpPolicy } from "../../../../src/vault-ops/gateway";
import type { VaultOperation } from "../../../../src/vault-ops/types";

/**
 * section 6.2 lock-in: the auto-apply layer hard-refuses a security-breaching op *in its
 * own right*.
 *
 * The normal flow rejects an out-of-vault path at conversion/validation (layer 1),
 * so it never becomes an `auto` op. This suite drives the auto-apply path *directly*,
 * simulating a future refactor that dropped the conversion-stage rejection, by
 * forcing `toVaultOperations` to emit an escaping op. It then proves
 * {@link LiveVaultReview.applyAuto}'s own boundary guard refuses it: the op is
 * reported `failed` with an out-of-vault reason, nothing is recorded as applied, and
 * the disk-touching {@link applyVaultOpBatch} is **never even called**. That last
 * assertion is the point, auto-apply defends the vault boundary before delegating,
 * so a hole in conversion (or a hypothetically-broken pre-flight) cannot let an
 * escaping write reach disk. Covers both providers, which share `resolveRound`.
 */

// DOM-free timeline (mirrors liveVaultReview.test.ts): capture the proposal so the
// test can read each op's resolved status.
const captured = vi.hoisted(() => ({
  proposalOps: [] as Array<{ id: string; status: string; gate: string }>,
}));
vi.mock("../../../../src/chat/messages/vaultReviewTimeline", () => ({
  VaultReviewTimelineView: class {
    constructor(opts: { proposal: { ops: typeof captured.proposalOps } }) {
      captured.proposalOps = opts.proposal.ops;
    }
  },
}));

// Simulate a future refactor that dropped the conversion-stage rejection: force the
// conversion layer to emit a (directly constructed) op instead of an error, so an
// escaping path reaches the auto-apply path. This is section 6.2's "an op constructed
// directly", bypassing the layer-1 validators.
const injected = vi.hoisted(() => ({ op: null as VaultOperation | null }));
vi.mock("../../../../src/tools/vault-ops/conversion", () => ({
  toVaultOperations: (calls: ToolCall[]) => {
    const op = injected.op;
    if (!op) return { ops: [], sources: [], satisfied: [], errors: [] };
    return { ops: [op], sources: [calls[0].id], satisfied: [false], errors: [] };
  },
}));

// Spy the disk-touching batch executor so the test can assert it is NEVER reached
// for an escaping op, and make it *succeed* if it ever were, so the only thing
// standing between the escape and a "write" is the auto-apply guard under test.
const applyBatchSpy = vi.hoisted(() =>
  vi.fn(async (_app: unknown, batch: Array<{ id: string; op: VaultOperation }>) => ({
    ok: true,
    conflicts: [],
    applied: batch.map((b) => ({
      opId: b.id,
      inverse: { kind: "trash", path: "x", expect: { mtime: 0, size: 0 }, snapshot: "" },
    })),
  })),
);
vi.mock("../../../../src/vault-ops/applyBatch", () => ({
  applyVaultOpBatch: applyBatchSpy,
}));

import { LiveVaultReview } from "../../../../src/chat/actions/liveVaultReview";

function makeApp(): App {
  return {
    vault: {
      getName: () => "ExampleVault",
      getAbstractFileByPath: () => null,
      getFileByPath: () => null,
      read: () => Promise.resolve(""),
    },
    metadataCache: { getBacklinksForFile: () => ({ data: {} }) },
  } as unknown as App;
}

const POLICY = (overrides: Partial<VaultOpPolicy> = {}): VaultOpPolicy => ({
  create: "auto",
  overwrite: "auto",
  move: "auto",
  trash: "auto",
  createDir: "auto",
  edit: "auto",
  memory: "ask",
  scopes: [],
  maxAutoOps: 20,
  ...overrides,
});

const TIMELINE_EL = {} as unknown as HTMLElement;

beforeEach(() => {
  captured.proposalOps = [];
  injected.op = null;
  applyBatchSpy.mockClear();
});

describe("LiveVaultReview auto-apply vault-boundary guard (section 6.2)", () => {
  it("refuses an escaping create op forced into the auto path, never touching the batch", async () => {
    injected.op = { kind: "create", path: "../../outside-vault.md", content: "pwned" };
    const review = new LiveVaultReview({
      app: makeApp(),
      timelineEl: TIMELINE_EL,
      policy: POLICY({ create: "auto" }),
    });

    const [{ result }] = await review.resolveRound([
      { id: "c1", name: "write_file", arguments: { path: "../../outside-vault.md", content: "pwned" } },
    ]);

    // Reported as a failure, with the out-of-vault reason the model can act on.
    expect(result.isError).toBe(true);
    expect(result.failure?.kind).toBe("failed");
    expect(result.content).toContain("outside the vault");
    // The op is marked failed on the timeline, and nothing was applied…
    expect(captured.proposalOps[0].status).toBe("failed");
    expect(review.getAppliedRecord()).toBeNull();
    // …because the guard short-circuited *before* the disk-touching batch ran.
    expect(applyBatchSpy).not.toHaveBeenCalled();
  });

  it("refuses an escaping drive-letter overwrite forced into the auto path", async () => {
    injected.op = {
      kind: "overwrite",
      path: "C:/Windows/System32/hosts",
      content: "x",
      expect: { mtime: 1, size: 1 },
    };
    const review = new LiveVaultReview({
      app: makeApp(),
      timelineEl: TIMELINE_EL,
      policy: POLICY({ overwrite: "auto" }),
    });

    const [{ result }] = await review.resolveRound([
      { id: "c1", name: "write_file", arguments: { path: "C:/Windows/System32/hosts", content: "x" } },
    ]);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the vault");
    expect(review.getAppliedRecord()).toBeNull();
    expect(applyBatchSpy).not.toHaveBeenCalled();
  });

  it("refuses an escaping move endpoint (either side) forced into the auto path", async () => {
    // The destination escapes even though the source is in-vault, both endpoints
    // are checked, so the move cannot land a file outside the vault.
    injected.op = {
      kind: "move",
      from: "Notes/A.md",
      to: "../../../A.md",
      expect: { mtime: 1, size: 1 },
    };
    const review = new LiveVaultReview({
      app: makeApp(),
      timelineEl: TIMELINE_EL,
      policy: POLICY({ move: "auto" }),
    });

    const [{ result }] = await review.resolveRound([
      { id: "c1", name: "move_file", arguments: { from: "Notes/A.md", to: "../../../A.md" } },
    ]);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the vault");
    expect(result.content).toContain("../../../A.md");
    expect(review.getAppliedRecord()).toBeNull();
    expect(applyBatchSpy).not.toHaveBeenCalled();
  });

  it("still auto-applies an in-vault op (guard does not over-reject internal '..')", async () => {
    // Control: an internal `..` that stays inside the vault must NOT be refused,
    // the guard rejects only escapes, and the normal auto path still reaches disk.
    injected.op = { kind: "create", path: "Notes/sub/../A.md", content: "ok" };
    const review = new LiveVaultReview({
      app: makeApp(),
      timelineEl: TIMELINE_EL,
      policy: POLICY({ create: "auto" }),
    });

    const [{ result }] = await review.resolveRound([
      { id: "c1", name: "write_file", arguments: { path: "Notes/sub/../A.md", content: "ok" } },
    ]);

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("auto-applied");
    expect(applyBatchSpy).toHaveBeenCalledTimes(1);
    expect(review.getAppliedRecord()?.applied).toHaveLength(1);
  });
});

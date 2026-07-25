import { describe, it, expect } from "vitest";
import type { App } from "obsidian";
import type { ToolCall } from "../../../src/tools/types";
import type { VaultOperation } from "../../../src/vault-ops/types";
import type { VaultOpPolicy } from "../../../src/vault-ops/gateway";
import {
  preReadTrashSnapshots,
  gateConvertedOp,
  buildReviewableOp,
} from "../../../src/vault-ops/proposalSupport";

function policy(overrides: Partial<VaultOpPolicy> = {}): VaultOpPolicy {
  return {
    create: "ask",
    overwrite: "ask",
    move: "ask",
    trash: "ask",
    createDir: "ask",
    edit: "ask",
    memory: "ask",
    scopes: [],
    maxAutoOps: 20,
    ...overrides,
  };
}

const createOp = (path = "new.md"): VaultOperation =>
  ({ kind: "create", path, content: "x" }) as unknown as VaultOperation;
const moveOp = (from = "old.md", to = "new.md"): VaultOperation =>
  ({ kind: "move", from, to }) as unknown as VaultOperation;

function call(name: string, args: Record<string, unknown>, id = "c1"): ToolCall {
  return { id, name, arguments: args } as unknown as ToolCall;
}

describe("gateConvertedOp", () => {
  it("forces an already-satisfied op to auto without consuming budget", () => {
    // Even when the policy would otherwise gate it (ask), a satisfied no-op is auto
    // and must NOT spend an auto slot.
    const result = gateConvertedOp(createOp(), true, policy({ create: "ask" }), 0);
    expect(result).toEqual({ gate: "auto", autoConsumed: false });
  });

  it("auto-gates and consumes a slot for a fresh op under an auto policy", () => {
    const result = gateConvertedOp(createOp(), false, policy({ create: "auto" }), 0);
    expect(result).toEqual({ gate: "auto", autoConsumed: true });
  });

  it("returns ask without consuming budget under an ask policy", () => {
    const result = gateConvertedOp(createOp(), false, policy({ create: "ask" }), 0);
    expect(result).toEqual({ gate: "ask", autoConsumed: false });
  });

  it("returns deny without consuming budget under a deny policy", () => {
    const result = gateConvertedOp(createOp(), false, policy({ create: "deny" }), 0);
    expect(result).toEqual({ gate: "deny", autoConsumed: false });
  });

  it("threads autoSoFar: an over-budget auto op downgrades to ask, no slot spent", () => {
    const result = gateConvertedOp(
      createOp(),
      false,
      policy({ create: "auto", maxAutoOps: 1 }),
      1,
    );
    expect(result).toEqual({ gate: "ask", autoConsumed: false });
  });
});

describe("buildReviewableOp", () => {
  const app = {} as App;

  it("builds a pending reviewable for a fresh non-move op (no linkImpact)", () => {
    const op = createOp("a.md");
    const r = buildReviewableOp(app, op, "ask", false, "src-1");
    expect(r.op).toBe(op);
    expect(r.gate).toBe("ask");
    expect(r.status).toBe("pending");
    expect(r.sourceToolCallId).toBe("src-1");
    expect(typeof r.summary).toBe("string");
    expect(r.summary.length).toBeGreaterThan(0);
    expect(typeof r.id).toBe("string");
    expect(r.linkImpact).toBeUndefined();
  });

  it("marks a satisfied op as satisfied", () => {
    const r = buildReviewableOp(app, createOp("a.md"), "auto", true, "src-2");
    expect(r.status).toBe("satisfied");
  });

  it("attaches linkImpact (backlink count of the source) for a move op", () => {
    const fromFile = { path: "old.md" };
    const moveApp = {
      vault: { getFileByPath: (p: string) => (p === "old.md" ? fromFile : null) },
      metadataCache: {
        getBacklinksForFile: () => ({ data: { "x.md": [], "y.md": [] } }),
      },
    } as unknown as App;
    const r = buildReviewableOp(moveApp, moveOp("old.md", "new.md"), "ask", false, "src-3");
    expect(r.linkImpact).toBe(2);
  });
});

describe("preReadTrashSnapshots", () => {
  function vaultApp(contents: Record<string, string>): App {
    return {
      vault: {
        getFileByPath: (p: string) => (p in contents ? { path: p } : null),
        read: async (file: { path: string }) => contents[file.path],
      },
    } as unknown as App;
  }

  it("snapshots only readable trash_file calls, keyed by normalized path", async () => {
    const app = vaultApp({ "doomed.md": "goodbye" });
    const calls = [
      call("trash_file", { path: "doomed.md" }, "t1"),
      call("write_file", { path: "doomed.md", content: "z" }, "w1"),
    ];
    const snapshots = await preReadTrashSnapshots(app, calls);
    expect([...snapshots.entries()]).toEqual([["doomed.md", "goodbye"]]);
  });

  it("ignores a trash_file whose path is not a string", async () => {
    const app = vaultApp({ "doomed.md": "goodbye" });
    const snapshots = await preReadTrashSnapshots(app, [call("trash_file", { path: 42 }, "t1")]);
    expect(snapshots.size).toBe(0);
  });

  it("omits a trash_file whose content is unreadable (absent file)", async () => {
    const app = vaultApp({});
    const snapshots = await preReadTrashSnapshots(app, [
      call("trash_file", { path: "ghost.md" }, "t1"),
    ]);
    expect(snapshots.size).toBe(0);
  });
});

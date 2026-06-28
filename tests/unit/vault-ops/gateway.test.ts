import { describe, test, expect } from "vitest";
import {
  classOf,
  inScope,
  resolveEditGate,
  resolveGate,
  targetPaths,
} from "../../../src/vault-ops/gateway";
import type { VaultOpPolicy } from "../../../src/vault-ops/gateway";
import type { VaultOperation } from "../../../src/vault-ops/types";

const FP = { mtime: 1, size: 1 };

const basePolicy: VaultOpPolicy = {
  create: "auto",
  overwrite: "ask",
  move: "ask",
  trash: "deny",
  createDir: "auto",
  edit: "ask",
  scopes: [],
  maxAutoOps: 20,
};

const create = (path: string): VaultOperation => ({ kind: "create", path, content: "x" });
const move = (from: string, to: string): VaultOperation => ({ kind: "move", from, to, expect: FP });
const replace = (paths: string[]): VaultOperation => ({
  kind: "replaceInVault",
  search: "old",
  replace: "new",
  caseSensitive: false,
  wholeWord: false,
  targets: paths.map((p) => ({ path: p, content: "x", expect: FP })),
  occurrences: paths.length,
});

describe("classOf / targetPaths", () => {
  test("class is the op kind", () => {
    expect(classOf(create("a.md"))).toBe("create");
    expect(classOf(move("a.md", "b.md"))).toBe("move");
  });

  test("a replace is gated as an overwrite (the one class ≠ kind exception)", () => {
    expect(classOf(replace(["a.md"]))).toBe("overwrite");
  });

  test("move touches both endpoints; a replace touches every target; others one", () => {
    expect(targetPaths(move("a.md", "b/c.md"))).toEqual(["a.md", "b/c.md"]);
    expect(targetPaths(create("a.md"))).toEqual(["a.md"]);
    expect(targetPaths(replace(["Lore/a.md", "Lore/b.md"]))).toEqual(["Lore/a.md", "Lore/b.md"]);
  });

  test("a replace resolves through the overwrite gate", () => {
    expect(resolveGate(replace(["a.md"]), basePolicy, 0)).toBe("ask"); // overwrite is "ask"
    expect(resolveGate(replace(["a.md"]), { ...basePolicy, overwrite: "deny" }, 0)).toBe("deny");
  });

  test("folder ops reuse their file siblings' gate class (moveFolder→move, trashFolder→trash)", () => {
    const moveFolder: VaultOperation = { kind: "moveFolder", from: "A", to: "B" };
    const trashFolder: VaultOperation = { kind: "trashFolder", path: "A" };
    expect(classOf(moveFolder)).toBe("move");
    expect(classOf(trashFolder)).toBe("trash");
    // A moveFolder touches both endpoints, like a file move.
    expect(targetPaths(moveFolder)).toEqual(["A", "B"]);
    expect(targetPaths(trashFolder)).toEqual(["A"]);
  });

  test("a folder op resolves through its borrowed policy knob", () => {
    const moveFolder: VaultOperation = { kind: "moveFolder", from: "A", to: "B" };
    const trashFolder: VaultOperation = { kind: "trashFolder", path: "A" };
    // basePolicy: move = "ask", trash = "deny".
    expect(resolveGate(moveFolder, basePolicy, 0)).toBe("ask");
    expect(resolveGate(trashFolder, basePolicy, 0)).toBe("deny");
    // Flip the borrowed knobs and the folder op follows.
    expect(resolveGate(moveFolder, { ...basePolicy, move: "deny" }, 0)).toBe("deny");
  });
});

describe("inScope", () => {
  test("empty scopes ⇒ whole vault", () => {
    expect(inScope(["anywhere/x.md"], [])).toBe(true);
  });

  test("path under a scope prefix", () => {
    expect(inScope(["AI drafts/x.md"], ["AI drafts"])).toBe(true);
    expect(inScope(["AI drafts"], ["AI drafts"])).toBe(true);
  });

  test("prefix must align on a folder boundary", () => {
    expect(inScope(["AI draftsX/x.md"], ["AI drafts"])).toBe(false);
  });

  test("every path must be in scope (move)", () => {
    expect(inScope(["AI drafts/a.md", "elsewhere/b.md"], ["AI drafts"])).toBe(false);
    expect(inScope(["AI drafts/a.md", "AI drafts/b.md"], ["AI drafts"])).toBe(true);
  });

  test("trailing/leading slashes are tolerated", () => {
    expect(inScope(["/AI drafts/x.md"], ["AI drafts/"])).toBe(true);
  });
});

describe("resolveGate", () => {
  test("deny short-circuits regardless of scope/count", () => {
    expect(resolveGate({ kind: "trash", path: "a.md", expect: FP, snapshot: "" }, basePolicy, 0))
      .toBe("deny");
  });

  test("returns the base gate when in scope and under the cap", () => {
    expect(resolveGate(create("a.md"), basePolicy, 0)).toBe("auto");
    expect(resolveGate({ kind: "overwrite", path: "a.md", content: "x", expect: FP }, basePolicy, 0))
      .toBe("ask");
  });

  test("out-of-scope downgrades auto→ask", () => {
    const policy = { ...basePolicy, scopes: ["AI drafts"] };
    expect(resolveGate(create("AI drafts/a.md"), policy, 0)).toBe("auto");
    expect(resolveGate(create("elsewhere/a.md"), policy, 0)).toBe("ask");
  });

  test("count past maxAutoOps downgrades auto→ask", () => {
    const policy = { ...basePolicy, maxAutoOps: 2 };
    expect(resolveGate(create("a.md"), policy, 1)).toBe("auto");
    expect(resolveGate(create("a.md"), policy, 2)).toBe("ask");
  });

  test("downgrades never loosen an ask", () => {
    const policy: VaultOpPolicy = { ...basePolicy, overwrite: "ask", scopes: ["AI drafts"] };
    const op: VaultOperation = { kind: "overwrite", path: "AI drafts/a.md", content: "x", expect: FP };
    expect(resolveGate(op, policy, 0)).toBe("ask");
  });
});

describe("resolveEditGate", () => {
  test("returns the base edit gate when in scope and under the cap", () => {
    expect(resolveEditGate({ ...basePolicy, edit: "ask" }, "Story.md", 0)).toBe("ask");
    expect(resolveEditGate({ ...basePolicy, edit: "auto" }, "Story.md", 0)).toBe("auto");
  });

  test("deny short-circuits regardless of scope/count", () => {
    expect(resolveEditGate({ ...basePolicy, edit: "deny" }, "Story.md", 0)).toBe("deny");
  });

  test("out-of-scope downgrades auto→ask", () => {
    const policy = { ...basePolicy, edit: "auto" as const, scopes: ["AI drafts"] };
    expect(resolveEditGate(policy, "AI drafts/a.md", 0)).toBe("auto");
    expect(resolveEditGate(policy, "elsewhere/a.md", 0)).toBe("ask");
  });

  test("shares the per-turn auto budget, count past maxAutoOps downgrades auto→ask", () => {
    const policy = { ...basePolicy, edit: "auto" as const, maxAutoOps: 2 };
    expect(resolveEditGate(policy, "Story.md", 1)).toBe("auto");
    expect(resolveEditGate(policy, "Story.md", 2)).toBe("ask");
  });
});

// The "Edit automatically" posture (prompt-cache design §6.3) is a session-level
// blanket override: every op auto-applies, overriding the per-class gate (ask AND
// deny) and the scope restriction, bounded only by the maxAutoOps runaway backstop.
// The default "ask" posture leaves resolveGate / resolveEditGate exactly as before.
describe("approval posture override", () => {
  test("default posture is 'ask': the per-class policy fires unchanged", () => {
    // deny stays deny, auto stays auto, ask stays ask, scope/budget downgrades hold.
    expect(resolveGate(create("a.md"), basePolicy, 0, "ask")).toBe("auto");
    expect(resolveGate({ kind: "trash", path: "a.md", expect: FP, snapshot: "" }, basePolicy, 0, "ask"))
      .toBe("deny");
    expect(resolveEditGate({ ...basePolicy, edit: "deny" }, "Story.md", 0, "ask")).toBe("deny");
  });

  test("'auto' posture overrides an ask-classed op to auto", () => {
    expect(resolveGate({ kind: "overwrite", path: "a.md", content: "x", expect: FP }, basePolicy, 0, "auto"))
      .toBe("auto");
    expect(resolveEditGate({ ...basePolicy, edit: "ask" }, "Story.md", 0, "auto")).toBe("auto");
  });

  test("'auto' posture overrides even a deny-classed op to auto", () => {
    const trash: VaultOperation = { kind: "trash", path: "a.md", expect: FP, snapshot: "" };
    expect(resolveGate(trash, basePolicy, 0, "auto")).toBe("auto"); // trash is "deny" in basePolicy
    expect(resolveEditGate({ ...basePolicy, edit: "deny" }, "Story.md", 0, "auto")).toBe("auto");
  });

  test("'auto' posture ignores the scope restriction", () => {
    const policy = { ...basePolicy, scopes: ["AI drafts"] };
    // Out of scope would downgrade to ask under "ask"; "auto" applies anyway.
    expect(resolveGate(create("elsewhere/a.md"), policy, 0, "auto")).toBe("auto");
  });

  test("'auto' posture still respects the maxAutoOps runaway backstop", () => {
    const policy = { ...basePolicy, maxAutoOps: 2 };
    expect(resolveGate({ kind: "trash", path: "a.md", expect: FP, snapshot: "" }, policy, 1, "auto"))
      .toBe("auto");
    expect(resolveGate({ kind: "trash", path: "a.md", expect: FP, snapshot: "" }, policy, 2, "auto"))
      .toBe("ask");
    expect(resolveEditGate(policy, "Story.md", 2, "auto")).toBe("ask");
  });
});

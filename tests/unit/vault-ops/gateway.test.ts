import { describe, test, expect } from "vitest";
import { classOf, inScope, resolveGate, targetPaths } from "../../../src/vault-ops/gateway";
import type { VaultOpPolicy } from "../../../src/vault-ops/gateway";
import type { VaultOperation } from "../../../src/vault-ops/types";

const FP = { mtime: 1, size: 1 };

const basePolicy: VaultOpPolicy = {
  create: "auto",
  overwrite: "ask",
  move: "ask",
  trash: "deny",
  createDir: "auto",
  scopes: [],
  maxAutoOps: 20,
};

const create = (path: string): VaultOperation => ({ kind: "create", path, content: "x" });
const move = (from: string, to: string): VaultOperation => ({ kind: "move", from, to, expect: FP });

describe("classOf / targetPaths", () => {
  test("class is the op kind", () => {
    expect(classOf(create("a.md"))).toBe("create");
    expect(classOf(move("a.md", "b.md"))).toBe("move");
  });

  test("move touches both endpoints; others one", () => {
    expect(targetPaths(move("a.md", "b/c.md"))).toEqual(["a.md", "b/c.md"]);
    expect(targetPaths(create("a.md"))).toEqual(["a.md"]);
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

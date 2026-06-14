import { describe, it, expect } from "vitest";
import { formatBytes, summarizeOp, gateBadgeLabel } from "../../../src/vault-ops/summary";
import type { VaultOperation } from "../../../src/vault-ops/types";

const FP = { mtime: 1, size: 2 };

describe("formatBytes", () => {
  it("formats small sizes in bytes", () => {
    expect(formatBytes("hello")).toBe("5 B");
    expect(formatBytes("")).toBe("0 B");
  });

  it("formats kilobytes with one decimal", () => {
    expect(formatBytes("x".repeat(2048))).toBe("2.0 KB");
  });

  it("counts UTF-8 byte length, not character length", () => {
    // "€" is 3 bytes in UTF-8.
    expect(formatBytes("€")).toBe("3 B");
  });
});

describe("summarizeOp", () => {
  it("summarizes a create with its size", () => {
    const op: VaultOperation = { kind: "create", path: "Characters/Vex.md", content: "hi" };
    expect(summarizeOp(op)).toBe("New file Characters/Vex.md (2 B)");
  });

  it("summarizes an overwrite", () => {
    const op: VaultOperation = { kind: "overwrite", path: "A.md", content: "abc", expect: FP };
    expect(summarizeOp(op)).toBe("Overwrite A.md (3 B)");
  });

  it("summarizes a createDir", () => {
    expect(summarizeOp({ kind: "createDir", path: "Characters/Minor" })).toBe(
      "New folder Characters/Minor",
    );
  });

  it("summarizes a move with an arrow", () => {
    const op: VaultOperation = { kind: "move", from: "Inbox/D.md", to: "C/D.md", expect: FP };
    expect(summarizeOp(op)).toBe("Move Inbox/D.md → C/D.md");
  });

  it("summarizes a trash", () => {
    const op: VaultOperation = { kind: "trash", path: "Old.md", expect: FP, snapshot: "x" };
    expect(summarizeOp(op)).toBe("Trash Old.md");
  });
});

describe("gateBadgeLabel", () => {
  it("maps gates to badge labels", () => {
    expect(gateBadgeLabel("auto")).toBe("Auto");
    expect(gateBadgeLabel("ask")).toBe("Review");
    expect(gateBadgeLabel("deny")).toBe("Denied");
  });
});

import { describe, test, expect } from "vitest";
import { buildOverlay, makeResolver } from "../../../../src/tools/vault-ops/overlay";
import type { PathState, VaultOperation } from "../../../../src/vault-ops/types";

const FP = { mtime: 1, size: 1 };

describe("buildOverlay", () => {
  test("creates and overwrites mark the path as a file", () => {
    const overlay = buildOverlay([
      { kind: "create", path: "a.md", content: "" },
      { kind: "overwrite", path: "b.md", content: "", expect: FP },
    ]);
    expect(overlay.get("a.md")).toBe("file");
    expect(overlay.get("b.md")).toBe("file");
  });

  test("createDir marks a dir", () => {
    expect(buildOverlay([{ kind: "createDir", path: "Dir" }]).get("Dir")).toBe("dir");
  });

  test("move clears the source and marks the destination", () => {
    const overlay = buildOverlay([{ kind: "move", from: "a.md", to: "b.md", expect: FP }]);
    expect(overlay.get("a.md")).toBe("absent");
    expect(overlay.get("b.md")).toBe("file");
  });

  test("trash marks the path absent", () => {
    expect(buildOverlay([{ kind: "trash", path: "a.md", expect: FP, snapshot: "" }]).get("a.md"))
      .toBe("absent");
  });

  test("later ops win (write then move)", () => {
    const ops: VaultOperation[] = [
      { kind: "create", path: "a.md", content: "" },
      { kind: "move", from: "a.md", to: "b.md", expect: FP },
    ];
    const overlay = buildOverlay(ops);
    expect(overlay.get("a.md")).toBe("absent");
    expect(overlay.get("b.md")).toBe("file");
  });
});

describe("makeResolver", () => {
  test("overlay takes precedence over disk", () => {
    const diskState = (p: string): PathState => (p === "a.md" ? "file" : "absent");
    const overlay = buildOverlay([{ kind: "trash", path: "a.md", expect: FP, snapshot: "" }]);
    const resolve = makeResolver(overlay, diskState);
    expect(resolve("a.md")).toBe("absent"); // overlay wins
    expect(resolve("other.md")).toBe("absent"); // falls through to disk
  });

  test("falls through to disk when overlay has no entry", () => {
    const diskState = (p: string): PathState => (p === "disk.md" ? "file" : "absent");
    const resolve = makeResolver(new Map(), diskState);
    expect(resolve("disk.md")).toBe("file");
  });
});

import { describe, test, expect } from "vitest";
import {
  validateCreateDirectory,
  validateMoveFile,
  validateTrashFile,
  validateWriteFile,
} from "../../../../src/tools/vault-ops/validation";
import type { PathState } from "../../../../src/vault-ops/types";

const absent = (): PathState => "absent";
const resolveWith = (states: Record<string, PathState>) => (p: string) => states[p] ?? "absent";

describe("validateWriteFile", () => {
  test("accepts a new path", () => {
    const r = validateWriteFile({ path: "a.md", content: "hi" }, absent);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args).toEqual({ path: "a.md", content: "hi" });
  });

  test("rejects a missing path", () => {
    expect(validateWriteFile({ content: "hi" }, absent).ok).toBe(false);
  });

  test("rejects non-string content", () => {
    expect(validateWriteFile({ path: "a.md", content: 5 }, absent).ok).toBe(false);
  });

  test("rejects writing over a folder", () => {
    const r = validateWriteFile({ path: "Dir", content: "x" }, resolveWith({ Dir: "dir" }));
    expect(r.ok).toBe(false);
  });

  test("allows writing over an existing file (becomes overwrite later)", () => {
    expect(validateWriteFile({ path: "a.md", content: "x" }, resolveWith({ "a.md": "file" })).ok)
      .toBe(true);
  });
});

describe("validateCreateDirectory", () => {
  test("accepts a folder path", () => {
    expect(validateCreateDirectory({ path: "New" }, absent).ok).toBe(true);
  });

  test("rejects a path that is a file", () => {
    expect(validateCreateDirectory({ path: "a.md" }, resolveWith({ "a.md": "file" })).ok).toBe(false);
  });

  test("treats an existing folder as already satisfied, not an error", () => {
    const result = validateCreateDirectory({ path: "Dir" }, resolveWith({ Dir: "dir" }));
    expect(result.ok).toBe(true);
    expect("satisfied" in result && result.satisfied).toBe(true);
  });
});

describe("validateMoveFile", () => {
  test("accepts an existing source to an absent destination", () => {
    const r = validateMoveFile({ from: "a.md", to: "b.md" }, resolveWith({ "a.md": "file" }));
    expect(r.ok).toBe(true);
  });

  test("rejects a missing source", () => {
    expect(validateMoveFile({ from: "a.md", to: "b.md" }, absent).ok).toBe(false);
  });

  test("rejects an occupied destination", () => {
    const r = validateMoveFile(
      { from: "a.md", to: "b.md" },
      resolveWith({ "a.md": "file", "b.md": "file" }),
    );
    expect(r.ok).toBe(false);
  });

  test("rejects identical from/to", () => {
    expect(validateMoveFile({ from: "a.md", to: "a.md" }, resolveWith({ "a.md": "file" })).ok)
      .toBe(false);
  });
});

describe("validateTrashFile", () => {
  test("accepts an existing file", () => {
    expect(validateTrashFile({ path: "a.md" }, resolveWith({ "a.md": "file" })).ok).toBe(true);
  });

  test("rejects an absent path", () => {
    expect(validateTrashFile({ path: "a.md" }, absent).ok).toBe(false);
  });

  test("rejects a folder (files only in v1)", () => {
    expect(validateTrashFile({ path: "Dir" }, resolveWith({ Dir: "dir" })).ok).toBe(false);
  });
});

describe("vault-boundary rejection (out-of-vault paths fail before the review gate)", () => {
  const ESCAPING = [
    "../../outside-vault.md",
    "..",
    "a/../../x.md",
    "C:/Windows/System32/test.md",
    "C:\\Windows\\System32\\test.md",
  ];

  test("validateWriteFile rejects each escaping path with a boundary explanation", () => {
    for (const path of ESCAPING) {
      const r = validateWriteFile({ path, content: "x" }, absent);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("outside the vault");
    }
  });

  test("validateCreateDirectory rejects an escaping path", () => {
    const r = validateCreateDirectory({ path: "../escape" }, absent);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("outside the vault");
  });

  test("validateMoveFile rejects an escaping source or destination", () => {
    const fromBad = validateMoveFile({ from: "../x.md", to: "B.md" }, absent);
    expect(fromBad.ok).toBe(false);
    if (!fromBad.ok) expect(fromBad.error).toContain("outside the vault");

    const toBad = validateMoveFile({ from: "A.md", to: "../../x.md" }, resolveWith({ "A.md": "file" }));
    expect(toBad.ok).toBe(false);
    if (!toBad.ok) expect(toBad.error).toContain("outside the vault");
  });

  test("validateTrashFile rejects an escaping path", () => {
    const r = validateTrashFile({ path: "../../secret.md" }, resolveWith({}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("outside the vault");
  });

  test("still allows an internal .. that stays inside the vault (no over-rejection)", () => {
    expect(validateWriteFile({ path: "a/../b.md", content: "x" }, absent).ok).toBe(true);
  });
});

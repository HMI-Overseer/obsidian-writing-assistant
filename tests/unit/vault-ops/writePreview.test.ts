import { describe, test, expect } from "vitest";
import { buildWritePreviewHunk } from "../../../src/vault-ops/writePreview";

describe("buildWritePreviewHunk", () => {
  test("create: null before yields an all-add hunk (no removed lines)", () => {
    const hunk = buildWritePreviewHunk(null, "line one\nline two\nline three", "op1");
    const { editBlock, contextBefore, contextAfter, startLine, endLine } = hunk.resolvedEdit;

    expect(editBlock.searchText).toBe("");
    expect(editBlock.replaceText).toBe("line one\nline two\nline three");
    expect(contextBefore).toEqual([]);
    expect(contextAfter).toEqual([]);
    expect(startLine).toBe(1);
    expect(endLine).toBe(3);
    expect(hunk.id).toBe("op1");
    expect(hunk.status).toBe("pending");
  });

  test("create: single-line file spans line 1 only", () => {
    const hunk = buildWritePreviewHunk(null, "just one line", "op");
    expect(hunk.resolvedEdit.startLine).toBe(1);
    expect(hunk.resolvedEdit.endLine).toBe(1);
  });

  test("overwrite: trims common prefix and suffix to the changed middle", () => {
    const before = "keep A\nkeep B\nOLD middle\nkeep C\nkeep D";
    const after = "keep A\nkeep B\nNEW middle\nkeep C\nkeep D";
    const hunk = buildWritePreviewHunk(before, after, "op", 1);
    const { editBlock, contextBefore, contextAfter, startLine, endLine } = hunk.resolvedEdit;

    expect(editBlock.searchText).toBe("OLD middle");
    expect(editBlock.replaceText).toBe("NEW middle");
    // Only one context line requested on each side.
    expect(contextBefore).toEqual(["keep B"]);
    expect(contextAfter).toEqual(["keep C"]);
    expect(startLine).toBe(3);
    expect(endLine).toBe(3);
  });

  test("overwrite: context is limited to the requested number of lines", () => {
    const before = "a\nb\nc\nd\nOLD\ne\nf\ng\nh";
    const after = "a\nb\nc\nd\nNEW\ne\nf\ng\nh";
    const hunk = buildWritePreviewHunk(before, after, "op", 2);
    expect(hunk.resolvedEdit.contextBefore).toEqual(["c", "d"]);
    expect(hunk.resolvedEdit.contextAfter).toEqual(["e", "f"]);
    expect(hunk.resolvedEdit.startLine).toBe(5);
    expect(hunk.resolvedEdit.endLine).toBe(5);
  });

  test("overwrite: multi-line changed region reports its full span", () => {
    const before = "head\nx1\nx2\nx3\ntail";
    const after = "head\ny1\ntail";
    const hunk = buildWritePreviewHunk(before, after, "op", 3);
    expect(hunk.resolvedEdit.editBlock.searchText).toBe("x1\nx2\nx3");
    expect(hunk.resolvedEdit.editBlock.replaceText).toBe("y1");
    expect(hunk.resolvedEdit.startLine).toBe(2);
    expect(hunk.resolvedEdit.endLine).toBe(4);
  });

  test("overwrite with identical content yields an empty hunk", () => {
    const hunk = buildWritePreviewHunk("same\ntext", "same\ntext", "op");
    expect(hunk.resolvedEdit.editBlock.searchText).toBe("");
    expect(hunk.resolvedEdit.editBlock.replaceText).toBe("");
  });

  test("overwrite: pure insertion never reports a backwards range", () => {
    const before = "top\nbottom";
    const after = "top\ninserted\nbottom";
    const hunk = buildWritePreviewHunk(before, after, "op", 3);
    expect(hunk.resolvedEdit.editBlock.searchText).toBe("");
    expect(hunk.resolvedEdit.editBlock.replaceText).toBe("inserted");
    expect(hunk.resolvedEdit.endLine).toBeGreaterThanOrEqual(hunk.resolvedEdit.startLine);
  });
});

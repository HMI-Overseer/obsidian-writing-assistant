import { describe, it, expect } from "vitest";
import { computeWordDiff, tokenize, buildSegments } from "../../../src/editing/wordDiff";

describe("tokenize", () => {
  it("splits on word boundaries", () => {
    expect(tokenize("hello world")).toEqual(["hello", " ", "world"]);
  });

  it("preserves leading whitespace", () => {
    expect(tokenize("  hello")).toEqual(["  ", "hello"]);
  });

  it("handles empty string", () => {
    expect(tokenize("")).toEqual([""]);
  });

  it("handles single word", () => {
    expect(tokenize("word")).toEqual(["word"]);
  });

  it("handles multiple spaces", () => {
    expect(tokenize("a  b")).toEqual(["a", "  ", "b"]);
  });
});

describe("buildSegments", () => {
  it("builds all three parts when present", () => {
    const result = buildSegments("pre", "mid", "suf");
    expect(result).toEqual([
      { text: "pre", highlighted: false },
      { text: "mid", highlighted: true },
      { text: "suf", highlighted: false },
    ]);
  });

  it("omits empty parts", () => {
    expect(buildSegments("", "mid", "")).toEqual([
      { text: "mid", highlighted: true },
    ]);
  });

  it("returns empty array when all parts empty", () => {
    expect(buildSegments("", "", "")).toEqual([]);
  });

  it("handles only prefix", () => {
    expect(buildSegments("pre", "", "")).toEqual([
      { text: "pre", highlighted: false },
    ]);
  });
});

describe("computeWordDiff", () => {
  it("returns unhighlighted segments for identical lines", () => {
    const result = computeWordDiff("hello world", "hello world");
    expect(result.removed).toEqual([{ text: "hello world", highlighted: false }]);
    expect(result.added).toEqual([{ text: "hello world", highlighted: false }]);
  });

  it("highlights only the changed word", () => {
    const result = computeWordDiff("hello world", "hello earth");
    // Common prefix: "hello ", common suffix: none
    // Removed middle: "world", added middle: "earth"
    expect(result.removed).toContainEqual({ text: "world", highlighted: true });
    expect(result.added).toContainEqual({ text: "earth", highlighted: true });
    // Both should have "hello " as unhighlighted prefix
    expect(result.removed[0]).toEqual({ text: "hello ", highlighted: false });
    expect(result.added[0]).toEqual({ text: "hello ", highlighted: false });
  });

  it("highlights entire line when completely different", () => {
    const result = computeWordDiff("foo", "bar");
    expect(result.removed).toEqual([{ text: "foo", highlighted: true }]);
    expect(result.added).toEqual([{ text: "bar", highlighted: true }]);
  });

  it("handles added content at the end", () => {
    const result = computeWordDiff("hello", "hello world");
    expect(result.removed[0]).toEqual({ text: "hello", highlighted: false });
    expect(result.added).toContainEqual({ text: "hello", highlighted: false });
    expect(result.added).toContainEqual({ text: " world", highlighted: true });
  });

  it("handles empty old line", () => {
    const result = computeWordDiff("", "new content");
    expect(result.added).toContainEqual({ text: "new content", highlighted: true });
  });

  it("handles empty new line", () => {
    const result = computeWordDiff("old content", "");
    expect(result.removed).toContainEqual({ text: "old content", highlighted: true });
  });
});

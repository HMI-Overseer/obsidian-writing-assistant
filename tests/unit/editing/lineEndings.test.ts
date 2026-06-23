import { describe, it, expect } from "vitest";
import { detectEol, toLf, fromLf } from "../../../src/editing/lineEndings";

describe("detectEol", () => {
  it("reports LF for a pure-LF document", () => {
    expect(detectEol("a\nb\nc")).toBe("\n");
  });

  it("reports CRLF for a pure-CRLF document", () => {
    expect(detectEol("a\r\nb\r\nc")).toBe("\r\n");
  });

  it("reports LF for a document with no newlines", () => {
    expect(detectEol("single line")).toBe("\n");
  });

  it("picks the majority convention for a mixed document", () => {
    expect(detectEol("a\r\nb\r\nc\nd")).toBe("\r\n"); // 2 CRLF vs 1 LF
    expect(detectEol("a\nb\nc\r\nd")).toBe("\n"); // 1 CRLF vs 2 LF
  });
});

describe("toLf", () => {
  it("strips CR from CRLF", () => {
    expect(toLf("a\r\nb\r\nc")).toBe("a\nb\nc");
  });

  it("converts a lone CR to LF", () => {
    expect(toLf("a\rb")).toBe("a\nb");
  });

  it("leaves LF text unchanged", () => {
    expect(toLf("a\nb")).toBe("a\nb");
  });
});

describe("fromLf", () => {
  it("expands LF to CRLF", () => {
    expect(fromLf("a\nb\nc", "\r\n")).toBe("a\r\nb\r\nc");
  });

  it("leaves text unchanged for LF", () => {
    expect(fromLf("a\nb\nc", "\n")).toBe("a\nb\nc");
  });

  it("round-trips with toLf for CRLF", () => {
    const original = "a\r\nb\r\nc";
    expect(fromLf(toLf(original), detectEol(original))).toBe(original);
  });

  it("does not double-expand (no \\r\\r\\n)", () => {
    // fromLf assumes LF-only input; toLf guarantees it.
    expect(fromLf(toLf("a\r\nb"), "\r\n")).not.toMatch(/\r\r/);
  });
});

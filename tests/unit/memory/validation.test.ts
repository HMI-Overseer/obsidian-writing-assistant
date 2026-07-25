import { describe, it, expect } from "vitest";
import {
  MEMORY_CONTENT_MAX_CODE_POINTS,
  MEMORY_DESCRIPTION_MAX_CODE_POINTS,
  MEMORY_NAME_MAX_LENGTH,
  codePointLength,
  isSingleLine,
  isValidMemoryName,
  normalizeMemoryName,
  validateMemoryCandidate,
  type MemoryCandidate,
} from "../../../src/memory/validation";

/** An astral-plane character: 2 UTF-16 units, 1 code point. */
const ASTRAL = String.fromCodePoint(0x1f642);
/** Unicode line separator, one of the banned single-line violations. */
const LINE_SEP = String.fromCodePoint(0x2028);
const PARA_SEP = String.fromCodePoint(0x2029);

function candidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    name: "my-memory",
    type: "rule",
    description: "A standing rule.",
    ...overrides,
  };
}

function issueOf(result: ReturnType<typeof validateMemoryCandidate>) {
  if (result.ok) throw new Error("expected a rejection");
  return result.issue;
}

describe("normalizeMemoryName", () => {
  it("lowercases and converts whitespace / underscores to hyphens", () => {
    expect(normalizeMemoryName("My Memory")).toBe("my-memory");
    expect(normalizeMemoryName("  Foo_Bar  ")).toBe("foo-bar");
  });

  it("strips characters outside [a-z0-9-], collapses runs, trims edge hyphens", () => {
    expect(normalizeMemoryName("café!!")).toBe("caf");
    expect(normalizeMemoryName("--a---b--")).toBe("a-b");
    expect(normalizeMemoryName("a.b/c")).toBe("abc");
  });

  it("returns empty when nothing survives", () => {
    expect(normalizeMemoryName("***")).toBe("");
    expect(normalizeMemoryName("")).toBe("");
  });
});

describe("isValidMemoryName", () => {
  it("accepts canonical kebab-case up to the length bound", () => {
    expect(isValidMemoryName("no-emdashes")).toBe(true);
    expect(isValidMemoryName("a".repeat(MEMORY_NAME_MAX_LENGTH))).toBe(true);
  });

  it("rejects uppercase, edge hyphens, empties, and over-long names", () => {
    expect(isValidMemoryName("No-Emdashes")).toBe(false);
    expect(isValidMemoryName("-leading")).toBe(false);
    expect(isValidMemoryName("trailing-")).toBe(false);
    expect(isValidMemoryName("double--hyphen")).toBe(false);
    expect(isValidMemoryName("")).toBe(false);
    expect(isValidMemoryName("a".repeat(MEMORY_NAME_MAX_LENGTH + 1))).toBe(false);
  });
});

describe("isSingleLine / codePointLength", () => {
  it("rejects line breaks, separators, and control characters", () => {
    expect(isSingleLine("plain text, punctuation: fine.")).toBe(true);
    expect(isSingleLine("a\nb")).toBe(false);
    expect(isSingleLine("a\rb")).toBe(false);
    expect(isSingleLine("a\tb")).toBe(false);
    expect(isSingleLine(`a${LINE_SEP}b`)).toBe(false);
    expect(isSingleLine(`a${PARA_SEP}b`)).toBe(false);
    expect(isSingleLine("a" + String.fromCodePoint(0x0000) + "b")).toBe(false);
    expect(isSingleLine("a" + String.fromCodePoint(0x009f) + "b")).toBe(false);
  });

  it("counts code points, not UTF-16 units", () => {
    expect(codePointLength(ASTRAL)).toBe(1);
    expect(ASTRAL.length).toBe(2);
    expect(codePointLength(ASTRAL.repeat(10))).toBe(10);
  });
});

describe("validateMemoryCandidate", () => {
  it("accepts a body-less rule and omits the content key", () => {
    const result = validateMemoryCandidate(candidate(), []);
    expect(result).toEqual({
      ok: true,
      value: { name: "my-memory", type: "rule", description: "A standing rule." },
    });
    if (result.ok) expect("content" in result.value).toBe(false);
  });

  it("accepts a context with content and preserves it verbatim", () => {
    const result = validateMemoryCandidate(
      candidate({ type: "context", content: "Line one.\nLine two." }),
      [],
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.content).toBe("Line one.\nLine two.");
  });

  it("rejects a non-canonical name with the normalized form to resubmit", () => {
    expect(issueOf(validateMemoryCandidate(candidate({ name: "My Memory" }), []))).toEqual({
      code: "name_invalid",
      normalized: "my-memory",
    });
  });

  it("rejects a missing or unsalvageable name with an empty suggestion", () => {
    expect(issueOf(validateMemoryCandidate(candidate({ name: undefined }), []))).toEqual({
      code: "name_invalid",
      normalized: "",
    });
    expect(issueOf(validateMemoryCandidate(candidate({ name: "***" }), []))).toEqual({
      code: "name_invalid",
      normalized: "",
    });
  });

  it("rejects an over-long name as name_invalid", () => {
    const long = "a".repeat(MEMORY_NAME_MAX_LENGTH + 1);
    expect(issueOf(validateMemoryCandidate(candidate({ name: long }), []))).toEqual({
      code: "name_invalid",
      normalized: long,
    });
  });

  it("rejects a collision case-insensitively, naming the stored colliding record", () => {
    expect(issueOf(validateMemoryCandidate(candidate(), ["my-memory"]))).toEqual({
      code: "name_exists",
      colliding: "my-memory",
    });
    expect(issueOf(validateMemoryCandidate(candidate(), ["My-Memory"]))).toEqual({
      code: "name_exists",
      colliding: "My-Memory",
    });
  });

  it("rejects an out-of-enum type", () => {
    expect(issueOf(validateMemoryCandidate(candidate({ type: "Rule" }), []))).toEqual({
      code: "type_invalid",
    });
    expect(issueOf(validateMemoryCandidate(candidate({ type: undefined }), []))).toEqual({
      code: "type_invalid",
    });
  });

  it("rejects an empty, whitespace-only, or non-string description", () => {
    for (const description of ["", "   ", undefined]) {
      expect(issueOf(validateMemoryCandidate(candidate({ description }), []))).toEqual({
        code: "description_empty",
      });
    }
  });

  it("rejects a multi-line or control-character description", () => {
    for (const description of ["a\nb", "a\rb", "a\tb", `a${LINE_SEP}b`]) {
      expect(issueOf(validateMemoryCandidate(candidate({ description }), []))).toEqual({
        code: "description_multiline",
      });
    }
  });

  it("rejects an over-long description with limit and actual", () => {
    const description = "x".repeat(MEMORY_DESCRIPTION_MAX_CODE_POINTS + 1);
    expect(issueOf(validateMemoryCandidate(candidate({ description }), []))).toEqual({
      code: "description_too_long",
      limit: MEMORY_DESCRIPTION_MAX_CODE_POINTS,
      actual: MEMORY_DESCRIPTION_MAX_CODE_POINTS + 1,
    });
  });

  it("measures the description in code points: an astral text at the bound passes", () => {
    const description = ASTRAL.repeat(MEMORY_DESCRIPTION_MAX_CODE_POINTS);
    expect(description.length).toBeGreaterThan(MEMORY_DESCRIPTION_MAX_CODE_POINTS);
    expect(validateMemoryCandidate(candidate({ description }), []).ok).toBe(true);
  });

  it("rejects a non-string content", () => {
    expect(issueOf(validateMemoryCandidate(candidate({ content: 42 }), []))).toEqual({
      code: "content_invalid",
    });
  });

  it("rejects over-long content with limit and actual, in code points", () => {
    const over = "x".repeat(MEMORY_CONTENT_MAX_CODE_POINTS + 1);
    expect(issueOf(validateMemoryCandidate(candidate({ content: over }), []))).toEqual({
      code: "content_too_long",
      limit: MEMORY_CONTENT_MAX_CODE_POINTS,
      actual: MEMORY_CONTENT_MAX_CODE_POINTS + 1,
    });
    const astralAtBound = ASTRAL.repeat(MEMORY_CONTENT_MAX_CODE_POINTS);
    expect(validateMemoryCandidate(candidate({ content: astralAtBound }), []).ok).toBe(true);
  });
});

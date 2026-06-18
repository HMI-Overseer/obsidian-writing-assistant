import { describe, it, expect } from "vitest";
import { toolFailure } from "../../../src/tools/toolFailure";
import type { ErrorKind } from "../../../src/tools/types";

const ALL_KINDS: ErrorKind[] = [
  "not-found",
  "invalid-args",
  "no-match",
  "ambiguous",
  "precondition",
  "unavailable",
  "denied",
  "failed",
];

describe("toolFailure", () => {
  it("composes an Error-prefixed sentence from what + recovery", () => {
    const r = toolFailure({
      kind: "not-found",
      what: 'no note found at path "Will.md"',
      recovery: "call list_directory to locate the correct path",
    });
    expect(r.content).toBe(
      'Error: no note found at path "Will.md". call list_directory to locate the correct path.',
    );
    expect(r.isError).toBe(true);
    expect(r.isReadOnly).toBe(true);
    expect(r.failure).toEqual({
      kind: "not-found",
      recovery: "call list_directory to locate the correct path",
    });
  });

  it("keeps the system-prompt-visible 'Error:' prefix on composed content", () => {
    expect(toolFailure({ kind: "invalid-args", what: "query is required" }).content).toMatch(
      /^Error: /,
    );
  });

  it("names a next step for EVERY kind even when the handler gives none", () => {
    // The contract's invariant: an error result always names what to try next.
    for (const kind of ALL_KINDS) {
      const r = toolFailure({ kind, what: "something failed" });
      expect(r.failure?.kind).toBe(kind);
      expect(r.failure?.recovery).toBeTruthy();
      // Composed content carries the recovery clause after the "what".
      expect(r.content).toContain(r.failure!.recovery!);
    }
  });

  it("normalizes terminal punctuation (single trailing period, no doubles)", () => {
    const r = toolFailure({
      kind: "invalid-args",
      what: "pattern is required.",
      recovery: "pass a glob pattern.",
    });
    expect(r.content).toBe("Error: pattern is required. pass a glob pattern.");
    expect(r.content).not.toContain("..");
  });

  it("passes pre-composed content through verbatim while still attaching failure", () => {
    const curated = "Semantic search did not run: no embedding model is configured. Use search_content.";
    const r = toolFailure({
      kind: "unavailable",
      content: curated,
      recovery: "use search_content for an exact-string lookup instead",
    });
    expect(r.content).toBe(curated);
    expect(r.failure).toEqual({
      kind: "unavailable",
      recovery: "use search_content for an exact-string lookup instead",
    });
  });

  it("defaults to the read channel but allows the mutation channel", () => {
    expect(toolFailure({ kind: "failed", what: "x" }).isReadOnly).toBe(true);
    expect(toolFailure({ kind: "failed", what: "x", isReadOnly: false }).isReadOnly).toBe(false);
  });
});

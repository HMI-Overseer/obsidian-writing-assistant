import { describe, it, expect } from "vitest";
import {
  assertMintBlobFits,
  mintBlobTokenLimit,
  ClaudeCodeContextOverflowError,
  CLAUDE_CODE_CONTEXT_RESERVE_TOKENS,
} from "../../../src/api/claudeCodeContextPreflight";

/** Capture whatever a call throws (or null), for asserting on the error object. */
function thrownBy(fn: () => void): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

describe("assertMintBlobFits", () => {
  it("does nothing when the context window is unknown (first turn / none reported)", () => {
    // A blob far larger than any window must not throw when there is no ceiling to
    // judge it against: the guard is passive, not a blind refusal.
    const huge = "x".repeat(10_000_000);
    expect(() => assertMintBlobFits(huge, "", undefined)).not.toThrow();
  });

  it("passes a blob comfortably within the reply-reserved budget", () => {
    expect(() => assertMintBlobFits("User: hello", "Be concise.", 200_000)).not.toThrow();
  });

  it("throws ClaudeCodeContextOverflowError when the blob overflows the budget", () => {
    const overChars = (mintBlobTokenLimit(200_000) + 1_000) * 4; // ~4 chars/token, over
    expect(() => assertMintBlobFits("x".repeat(overChars), "", 200_000)).toThrow(
      ClaudeCodeContextOverflowError,
    );
  });

  it("counts the appended system prompt toward the budget", () => {
    // The blob alone sits exactly at the limit (not over); the system prompt tips it.
    const blob = "x".repeat(mintBlobTokenLimit(200_000) * 4);
    expect(() => assertMintBlobFits(blob, "", 200_000)).not.toThrow();
    expect(() => assertMintBlobFits(blob, "x".repeat(8_000), 200_000)).toThrow(
      ClaudeCodeContextOverflowError,
    );
  });

  it("surfaces a clear, actionable message and the measured overflow", () => {
    const overChars = (mintBlobTokenLimit(200_000) + 1_000) * 4;
    const error = thrownBy(() => assertMintBlobFits("x".repeat(overChars), "", 200_000));
    expect(error).toBeInstanceOf(ClaudeCodeContextOverflowError);
    expect((error as Error).message).toMatch(/too large for Claude Code/i);
    expect((error as ClaudeCodeContextOverflowError).limit).toBe(mintBlobTokenLimit(200_000));
    expect((error as ClaudeCodeContextOverflowError).estimatedTokens).toBeGreaterThan(
      mintBlobTokenLimit(200_000),
    );
  });
});

describe("mintBlobTokenLimit", () => {
  it("reserves CLAUDE_CODE_CONTEXT_RESERVE_TOKENS below the discovered window", () => {
    // Ties the threshold to the single shared constant (section 6.4 "one number"): a divergent
    // cap would be a test failure here rather than a silent drift.
    expect(mintBlobTokenLimit(200_000)).toBe(200_000 - CLAUDE_CODE_CONTEXT_RESERVE_TOKENS);
    expect(mintBlobTokenLimit(1_000_000)).toBe(1_000_000 - CLAUDE_CODE_CONTEXT_RESERVE_TOKENS);
  });
});

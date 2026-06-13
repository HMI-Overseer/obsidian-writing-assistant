import { describe, it, expect } from "vitest";
import {
  extractClaudeCodeDelta,
  extractClaudeCodeResult,
  extractClaudeCodeError,
  resolveClaudeBinary,
} from "../../../src/api/claudeCodeProcess";

describe("extractClaudeCodeDelta", () => {
  it("extracts text from a stream_event content_block_delta", () => {
    const event = {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
    };
    expect(extractClaudeCodeDelta(event)).toBe("Hello");
  });

  it("returns null for non-text deltas and other event types", () => {
    expect(extractClaudeCodeDelta({ type: "result" })).toBeNull();
    expect(
      extractClaudeCodeDelta({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } },
      }),
    ).toBeNull();
    expect(extractClaudeCodeDelta({ type: "assistant", message: {} })).toBeNull();
  });
});

describe("extractClaudeCodeResult", () => {
  it("maps usage, cost, and session id from a result event", () => {
    const result = extractClaudeCodeResult({
      type: "result",
      subtype: "success",
      total_cost_usd: 0.0123,
      session_id: "abc-123",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 5,
      },
    });
    expect(result).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: 5,
      costUsd: 0.0123,
      sessionId: "abc-123",
    });
  });

  it("defaults token counts to zero and omits optional fields", () => {
    const result = extractClaudeCodeResult({ type: "result" });
    expect(result).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("returns null for non-result events", () => {
    expect(extractClaudeCodeResult({ type: "stream_event" })).toBeNull();
  });
});

describe("extractClaudeCodeError", () => {
  it("returns the result text for error results", () => {
    expect(
      extractClaudeCodeError({ type: "result", is_error: true, result: "Auth failed" }),
    ).toBe("Auth failed");
  });

  it("falls back to the subtype when no text is present", () => {
    expect(
      extractClaudeCodeError({ type: "result", is_error: true, subtype: "error_max_turns" }),
    ).toBe("Claude Code error: error_max_turns");
  });

  it("returns null for successful results", () => {
    expect(extractClaudeCodeError({ type: "result", is_error: false })).toBeNull();
    expect(extractClaudeCodeError({ type: "result" })).toBeNull();
  });
});

describe("resolveClaudeBinary", () => {
  it("returns a configured path verbatim", () => {
    expect(resolveClaudeBinary("/opt/claude/bin/claude")).toBe("/opt/claude/bin/claude");
    expect(resolveClaudeBinary("  C:\\tools\\claude.exe  ")).toBe("C:\\tools\\claude.exe");
  });
});

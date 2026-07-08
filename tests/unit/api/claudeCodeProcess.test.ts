import { describe, it, expect } from "vitest";
import {
  extractClaudeCodeDelta,
  extractClaudeCodeResult,
  extractClaudeCodeContextTokens,
  extractClaudeCodeError,
  resolveClaudeBinary,
  claudeCodeHarnessEnv,
} from "../../../src/api/claudeCodeProcess";

describe("claudeCodeHarnessEnv", () => {
  it("disables CLI compaction and mutes non-essential traffic", () => {
    const env = claudeCodeHarnessEnv();
    expect(env.DISABLE_COMPACT).toBe("1");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(env.DISABLE_NON_ESSENTIAL_MODEL_CALLS).toBe("1");
  });

  it("uses the stronger DISABLE_COMPACT, never the weaker auto flag, and sets no context cap", () => {
    // section 6.4 flag correction: DISABLE_COMPACT (not DISABLE_AUTO_COMPACT) is the switch,
    // and the plugin deliberately leaves CLAUDE_CODE_MAX_CONTEXT_TOKENS unset (the
    // per-conversation preflight is the ceiling instead).
    const env = claudeCodeHarnessEnv();
    expect(env.DISABLE_AUTO_COMPACT).toBeUndefined();
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
  });
});

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

  it("reads the context window of the MAIN model (most input tokens), not the largest window", () => {
    const result = extractClaudeCodeResult({
      type: "result",
      usage: { input_tokens: 1, output_tokens: 2 },
      modelUsage: {
        // Helper model with a bigger window but almost no traffic must not win.
        "claude-sonnet-4-5[1m]": { contextWindow: 1000000, inputTokens: 3, cacheReadInputTokens: 0 },
        "claude-opus-4-8": {
          contextWindow: 200000,
          inputTokens: 2700,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 14000,
        },
      },
    });
    expect(result?.contextWindow).toBe(200000);
  });

  it("falls back to the largest window when entries carry no token counts", () => {
    const result = extractClaudeCodeResult({
      type: "result",
      modelUsage: {
        "claude-haiku-4-5": { contextWindow: 200000 },
        "claude-opus-4-8": { contextWindow: 500000 },
      },
    });
    expect(result?.contextWindow).toBe(500000);
  });

  it("omits contextWindow when modelUsage is absent or carries no numbers", () => {
    expect(extractClaudeCodeResult({ type: "result" })?.contextWindow).toBeUndefined();
    expect(
      extractClaudeCodeResult({
        type: "result",
        modelUsage: { "claude-opus-4-8": { contextWindow: "big" } },
      })?.contextWindow,
    ).toBeUndefined();
  });
});

describe("extractClaudeCodeContextTokens", () => {
  it("sums prompt + cache tokens from a top-level assistant message", () => {
    const tokens = extractClaudeCodeContextTokens({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        usage: {
          input_tokens: 7,
          cache_creation_input_tokens: 1200,
          cache_read_input_tokens: 90000,
        },
      },
    });
    expect(tokens).toBe(91207);
  });

  it("ignores subagent messages and events without usage", () => {
    expect(
      extractClaudeCodeContextTokens({
        type: "assistant",
        parent_tool_use_id: "toolu_123",
        message: { usage: { input_tokens: 5 } },
      }),
    ).toBeNull();
    expect(extractClaudeCodeContextTokens({ type: "assistant", message: {} })).toBeNull();
    expect(extractClaudeCodeContextTokens({ type: "result" })).toBeNull();
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

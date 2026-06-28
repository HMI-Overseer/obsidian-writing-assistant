import { describe, it, expect } from "vitest";
import type { StopReason } from "../../../../src/api/usageTypes";
import {
  checkForFailedToolCall,
  type FailedRoundContext,
} from "../../../../src/chat/actions/toolLoop";

function ctx(overrides: Partial<FailedRoundContext> = {}): FailedRoundContext {
  return {
    hasToolCalls: false,
    roundText: "",
    stopReason: "end_turn" as StopReason,
    round: 0,
    maxRounds: 7,
    usage: null,
    model: "gemma-4",
    provider: "lmstudio",
    agenticMode: true,
    toolCount: 9,
    mode: "edit",
    ...overrides,
  };
}

/** Run the check and return the thrown message, or null if it didn't throw. */
function thrownMessage(c: FailedRoundContext): string | null {
  try {
    checkForFailedToolCall(c);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

describe("checkForFailedToolCall", () => {
  it("never throws when the round produced tool calls", () => {
    expect(() => checkForFailedToolCall(ctx({ hasToolCalls: true, roundText: "" }))).not.toThrow();
  });

  it("does not throw on an empty end_turn after a productive round (the regen case)", () => {
    // Gemma did its vault ops in round 0, then ends round 1 cleanly with no prose.
    expect(() =>
      checkForFailedToolCall(ctx({ round: 1, roundText: "", stopReason: "end_turn" })),
    ).not.toThrow();
  });

  it("still throws on an empty end_turn at round 0 (the model answered nothing)", () => {
    expect(thrownMessage(ctx({ round: 0, roundText: "", stopReason: "end_turn" }))).toMatch(
      /empty response/,
    );
  });

  it("throws on a tool_use stop with no parseable call, regardless of round", () => {
    expect(thrownMessage(ctx({ round: 3, roundText: "", stopReason: "tool_use" }))).toMatch(
      /no parseable call/,
    );
  });

  it("throws on raw tool-call markup even on a late round", () => {
    expect(
      thrownMessage(ctx({ round: 2, roundText: "[TOOL_CALLS] foo()", stopReason: "end_turn" })),
    ).toMatch(/raw tool-call markup/);
  });

  it("reports reasoning-only output when tokens were produced but no text", () => {
    expect(
      thrownMessage(
        ctx({
          round: 0,
          roundText: "",
          stopReason: "unknown",
          usage: { inputTokens: 10, outputTokens: 42 },
        }),
      ),
    ).toMatch(/reasoning-only/);
  });

  it("reports a server-tool pause distinctly, not as reasoning-only output", () => {
    // A pause_turn carries the in-flight server-tool tokens, so the generic
    // outputTokens branch would misread it as reasoning-only. The pause_turn branch
    // must win and name the real cause (the server tool-search loop hit its iteration
    // cap) so the recovery ("regenerate") is accurate. ADR-0009 B-hardening.
    const msg = thrownMessage(
      ctx({
        round: 2,
        roundText: "",
        stopReason: "pause_turn",
        usage: { inputTokens: 10, outputTokens: 42 },
      }),
    );
    expect(msg).toMatch(/server-side tool-search|paused/);
    expect(msg).not.toMatch(/reasoning-only/);
  });

  it("does not throw when the model produced normal text without tool calls", () => {
    expect(() =>
      checkForFailedToolCall(ctx({ round: 0, roundText: "Here is your answer.", stopReason: "end_turn" })),
    ).not.toThrow();
  });

  it("renders a multi-line, copyable diagnostics block with every field", () => {
    const msg = thrownMessage(
      ctx({
        round: 0,
        maxRounds: 7,
        roundText: "",
        stopReason: "end_turn",
        usage: { inputTokens: 12431, outputTokens: 0 },
        model: "gemma-4",
        provider: "lmstudio",
        agenticMode: true,
        toolCount: 9,
        mode: "edit",
      }),
    );
    expect(msg).not.toBeNull();
    const text = msg as string;
    // Multi-line: summary + labelled diagnostics on their own lines.
    expect(text.split("\n").length).toBeGreaterThan(8);
    expect(text).toContain("The model returned no usable response.");
    expect(text).toContain("Diagnostics (copy this when reporting the issue):");
    expect(text).toContain("Provider: lmstudio");
    expect(text).toContain("Model: gemma-4");
    expect(text).toContain("Round: 1 of 8");
    expect(text).toContain("Stop reason: end_turn");
    expect(text).toContain("Output tokens: 0");
    expect(text).toContain("Input tokens: 12431");
    expect(text).toContain("Mode: edit");
    expect(text).toContain("Agentic: on");
    expect(text).toContain("Tools attached: 9");
  });

  it("shows token fields as 'unknown' when the provider reported no usage", () => {
    const text = thrownMessage(ctx({ usage: null })) as string;
    expect(text).toContain("Output tokens: unknown");
    expect(text).toContain("Input tokens: unknown");
  });

  it("includes a flattened raw-output preview when the model emitted text", () => {
    const text = thrownMessage(
      ctx({ roundText: "[TOOL_REQUEST]\n  garbled\n  output", stopReason: "tool_use" }),
    ) as string;
    expect(text).toContain('Raw output: "[TOOL_REQUEST] garbled output"');
  });
});

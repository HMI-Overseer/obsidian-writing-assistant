import { describe, it, expect } from "vitest";
import type { MessageUsage } from "../../../src/shared/types";
import { describeSession } from "../../../src/chat/messages/UsageBadge";

function usage(overrides: Partial<MessageUsage> = {}): MessageUsage {
  return { inputTokens: 10, outputTokens: 5, ...overrides };
}

describe("describeSession", () => {
  it("returns null when the provider reports no session reuse", () => {
    // No sessionReused field → not Claude Code → no session line at all.
    expect(describeSession(usage())).toBeNull();
  });

  it("labels a reused live session as a win", () => {
    expect(describeSession(usage({ sessionReused: true }))).toEqual({
      text: "session reused",
      state: "reused",
    });
  });

  it("treats a first-turn cold mint as a neutral start, not a regression", () => {
    expect(describeSession(usage({ sessionReused: false, sessionRebuildReason: "no-session" }))).toEqual({
      text: "session started",
      state: "started",
    });
  });

  it("names the cause of a config-driven rebuild", () => {
    expect(
      describeSession(usage({ sessionReused: false, sessionRebuildReason: "system-prompt-changed" })),
    ).toEqual({ text: "session rebuilt · prompt changed", state: "rebuilt" });
    expect(
      describeSession(usage({ sessionReused: false, sessionRebuildReason: "tools-changed" })),
    ).toEqual({ text: "session rebuilt · tools changed", state: "rebuilt" });
  });

  it("shows a bare 'session rebuilt' for a disposed prior session", () => {
    expect(
      describeSession(usage({ sessionReused: false, sessionRebuildReason: "session-disposed" })),
    ).toEqual({ text: "session rebuilt", state: "rebuilt" });
  });

  it("falls back to a bare 'session rebuilt' when no reason was recorded", () => {
    // Defensive: a rebuild always carries a reason via the live path, but a
    // hand-built / older persisted record might not.
    expect(describeSession(usage({ sessionReused: false }))).toEqual({
      text: "session rebuilt",
      state: "rebuilt",
    });
  });
});

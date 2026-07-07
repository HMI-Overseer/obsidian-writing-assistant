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

  it("labels a disk-resumed session as the middle recovery rung (Model A′)", () => {
    // Process was gone, session restored from disk: not a warm reuse, not a rebuild.
    expect(describeSession(usage({ sessionReused: false, sessionResumed: true }))).toEqual({
      text: "session resumed",
      state: "resumed",
    });
  });

  it("prefers a warm reuse over the resumed flag when both somehow appear", () => {
    // A live reuse is the strongest signal; sessionResumed never rides a reused turn,
    // but the ordering must not misreport one if it did.
    expect(
      describeSession(usage({ sessionReused: true, sessionResumed: true })),
    ).toEqual({ text: "session reused", state: "reused" });
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
    ).toEqual({ text: "synthetic rebuild · prompt changed", state: "rebuilt" });
    expect(
      describeSession(usage({ sessionReused: false, sessionRebuildReason: "tools-changed" })),
    ).toEqual({ text: "synthetic rebuild · tools changed", state: "rebuilt" });
  });

  it("labels an idle-evicted (disposed) prior session as 'expired'", () => {
    // The disposal tombstone (Phase 1) makes `session-disposed` reachable again;
    // the short-circuit that suppressed its label is fixed, so "expired" renders.
    expect(
      describeSession(usage({ sessionReused: false, sessionRebuildReason: "session-disposed" })),
    ).toEqual({ text: "synthetic rebuild · expired", state: "rebuilt" });
  });

  it("labels a compaction-driven rebuild as 'compacted'", () => {
    expect(
      describeSession(usage({ sessionReused: false, sessionRebuildReason: "compacted" })),
    ).toEqual({ text: "synthetic rebuild · compacted", state: "rebuilt" });
  });

  it("falls back to a bare 'synthetic rebuild' when no reason was recorded", () => {
    // Defensive: a rebuild always carries a reason via the live path, but a
    // hand-built / older persisted record might not.
    expect(describeSession(usage({ sessionReused: false }))).toEqual({
      text: "synthetic rebuild",
      state: "rebuilt",
    });
  });
});

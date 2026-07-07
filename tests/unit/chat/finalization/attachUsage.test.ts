import { describe, it, expect } from "vitest";
import { attachUsageToMessage } from "../../../../src/chat/finalization/finalizeResponse";
import { makeMessage } from "../../../../src/chat/conversation/conversationUtils";
import type { UsageResult } from "../../../../src/api/usageTypes";
import type { ClaudeCodeResumeCursor } from "../../../../src/shared/types";

/**
 * Phase 4: the Model A′ recovery fields cross from the turn's UsageResult onto the
 * persisted message, so the resume cursor lands in the conversation record (read back
 * next turn) and the badge can tell a disk resume from a warm reuse.
 */
describe("attachUsageToMessage: Model A′ recovery fields", () => {
  const cursor: ClaudeCodeResumeCursor = {
    sessionId: "sess-7",
    coveredCount: 4,
    prefixHash: "abc",
    configFingerprint: "fp",
  };

  function usage(overrides: Partial<UsageResult> = {}): UsageResult {
    return { inputTokens: 10, outputTokens: 5, ...overrides };
  }

  it("copies the banked resume cursor onto the message usage", () => {
    const message = makeMessage("assistant", "hi");
    attachUsageToMessage(message, undefined, "claudecode", usage({ resumeCursor: cursor }));
    expect(message.usage?.resumeCursor).toEqual(cursor);
  });

  it("copies the resumed flag for a disk-resumed turn", () => {
    const message = makeMessage("assistant", "hi");
    attachUsageToMessage(
      message,
      undefined,
      "claudecode",
      usage({ sessionReused: false, sessionResumed: true, resumeCursor: cursor }),
    );
    expect(message.usage?.sessionResumed).toBe(true);
    expect(message.usage?.sessionReused).toBe(false);
  });

  it("omits both fields when the turn carried neither (a non-claudecode / older turn)", () => {
    const message = makeMessage("assistant", "hi");
    attachUsageToMessage(message, undefined, "anthropic", usage());
    expect(message.usage?.resumeCursor).toBeUndefined();
    expect(message.usage?.sessionResumed).toBeUndefined();
  });
});

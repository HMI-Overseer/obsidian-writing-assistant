import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function source(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

describe("assistant turn Phase 8 architecture", () => {
  it("removes superseded assistant finalizers and session adapters", () => {
    expect(
      existsSync(join(ROOT, "src/chat/finalization/finalizeResponse.ts")),
    ).toBe(false);
    expect(
      existsSync(join(ROOT, "src/chat/finalization/finalizeEditResponse.ts")),
    ).toBe(false);

    const memory = source("src/chat/conversation/ChatSessionMemory.ts");
    const store = source("src/chat/conversation/ChatSessionStore.ts");
    const handler = source("src/chat/ChatBubbleActionHandler.ts");
    for (const retired of [
      "updateMessageContent(",
      "finalizeRegeneration(",
      "restoreRegeneration(",
      "switchMessageVersion(",
      "ensureRevisionBackedMessage(",
    ]) {
      expect(memory).not.toContain(retired);
      expect(store).not.toContain(retired);
      expect(handler).not.toContain(retired);
    }
  });

  it("keeps legacy review data read-only and removes positional matching", () => {
    const sendMessage = source("src/chat/actions/sendMessage.ts");
    const editReview = source("src/chat/messages/editReviewTimeline.ts");
    const vaultReview = source("src/chat/messages/vaultReviewTimeline.ts");

    expect(sendMessage).not.toContain("supersedePriorProposals");
    expect(editReview).not.toContain("const positional");
    expect(vaultReview).not.toContain("const positional");
    expect(vaultReview).not.toContain("const cursors");
  });

  it("contains no retired renderer or reasoning callback path", () => {
    for (const path of [
      "src/chat/messages/AgenticTimeline.ts",
      "src/chat/messages/AgenticTimeline.css",
      "src/chat/streaming/StreamingRenderer.ts",
      "src/chat/streaming/EditStreamingRenderer.ts",
    ]) {
      expect(existsSync(join(ROOT, path))).toBe(false);
    }

    const generation = source("src/chat/actions/generateLlmResponse.ts");
    const toolLoop = source("src/chat/actions/toolLoop.ts");
    for (const retired of [
      "onReasoningDelta",
      "onReasoningRoundFinished",
      "answerProse",
      "appendAnswerProse",
      "roundIsMutating",
    ]) {
      expect(generation).not.toContain(retired);
      expect(toolLoop).not.toContain(retired);
    }
  });
});

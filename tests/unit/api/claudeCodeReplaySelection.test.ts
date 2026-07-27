import { describe, expect, it } from "vitest";
import {
  ClaudeCodeClient,
  type SdkSessionTurnInput,
} from "../../../src/api/ClaudeCodeClient";
import type { AssistantStreamEvent } from "../../../src/api/usageTypes";
import type { AssistantStreamRun } from "../../../src/api/assistantStreamRun";
import { detachedAttemptContext } from "../../../src/api/assistantStreamRuntime";
import type {
  ClaudeCodeResumeCursor,
  SamplingParams,
} from "../../../src/shared/types";
import type { ChatRequest } from "../../../src/shared/chatRequest";
import type { SessionRecovery } from "../../../src/api/harnessSession";
import { proseTurnFrames } from "../../helpers/captureFrames";

const cursor: ClaudeCodeResumeCursor = {
  sessionId: "session-1",
  coveredCount: 2,
  prefixHash: "prefix",
  configFingerprint: "config",
};

function clientFor(decision: SessionRecovery): ClaudeCodeClient {
  return new ClaudeCodeClient("claude", {
    useSdk: true,
    sdkSession: {
      conversationId: "conversation-1",
      run: (input: SdkSessionTurnInput) =>
        (async function* () {
          input.onRecoveryDecision?.(decision);
          yield* proseTurnFrames(["Done."]);
        })(),
      hardDispose: () => Promise.resolve(),
    },
  });
}

function request(): ChatRequest {
  return {
    systemPrompt: "",
    documentContext: null,
    ragContext: null,
    messages: [{ role: "user", content: "Continue." }],
    replayEvidence: {
      tier: "textual",
      capabilities: {
        captureOrder: "exact",
        toolCorrelation: "provider_id",
        coldReplay: "textual",
        nativeResume: true,
      },
      loweredReason: "claude_code_textual_cold_replay",
    },
  };
}

async function evidenceFor(decision: SessionRecovery) {
  const result = clientFor(decision).stream(
    request(),
    "claude-test",
    { reasoning: "high" } as SamplingParams,
    detachedAttemptContext("t"),
  );
  await drain(result);
  return result.replayEvidence;
}

async function drain(result: AssistantStreamRun<AssistantStreamEvent>): Promise<void> {
  for await (const _event of result.events) {
    // Drain the stream so terminal fidelity resolves.
  }
}

describe("Phase 6 Claude Code replay selection", () => {
  it.each([
    { outcome: "reused" } as const,
    { outcome: "resumed", cursor } as const,
  ])("reports native for $outcome session continuation", async (decision) => {
    await expect(evidenceFor(decision)).resolves.toMatchObject({
      tier: "native",
      capabilities: {
        coldReplay: "textual",
        nativeResume: true,
      },
    });
  });

  it("reports textual for an edited-history cold rebuild", async () => {
    await expect(
      evidenceFor({ outcome: "rebuilt", reason: "history-edited" }),
    ).resolves.toMatchObject({
      tier: "textual",
      capabilities: {
        coldReplay: "textual",
        nativeResume: false,
      },
    });
  });
});

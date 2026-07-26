import { describe, expect, it } from "vitest";
import {
  estimateContextCapacityTokens,
  projectContextHistoryTurns,
  type ContextInputs,
} from "../../../src/chat/ContextCapacityUpdater";
import { estimateTokenCount } from "../../../src/shared/tokenEstimation";
import type { ConversationMessage } from "../../../src/shared/types";

function chainMessage(): ConversationMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    content: "stale",
    revisions: [
      {
        revisionId: "revision-1",
        kind: "turn",
        origin: "generated",
        createdAt: 1,
        provider: "openai",
        modelId: "gpt-test",
        turn: {
          schemaVersion: 1,
          id: "turn-1",
          status: "completed",
          segments: [{ id: "s1" }],
          items: [
            { type: "prose", id: "p1", segmentId: "s1", text: "Readable." },
            {
              type: "tool_call",
              id: "t1",
              segmentId: "s1",
              toolCallId: "call-1",
              toolName: "read_file",
              toolArguments: '{"path":"large-note-name.md"}',
              toolArgs: { path: "large-note-name.md" },
              state: "completed",
              resultRecord: "bounded structural result evidence",
            },
          ],
        },
      },
    ],
    activeRevisionId: "revision-1",
  };
}

describe("Phase 6 context capacity projection", () => {
  it("estimates the actual projected history including structural call and result overhead", () => {
    const inputs: ContextInputs = {
      systemPrompt: "System.",
      documentContext: null,
      messages: [
        { id: "user-1", role: "user", content: "Question." },
        chainMessage(),
      ],
      draft: "Next.",
      contextWindowSize: 100_000,
      activeProvider: "openai",
    };
    const projected = projectContextHistoryTurns(inputs);

    expect(projected.some((turn) => turn.assistantContent?.length)).toBe(true);
    expect(projected.some((turn) => turn.role === "tool")).toBe(true);
    expect(estimateContextCapacityTokens(inputs)).toBe(
      estimateTokenCount(
        {
          systemPrompt: inputs.systemPrompt,
          documentContext: inputs.documentContext,
          ragContext: null,
          messages: projected,
        },
        inputs.draft,
      ),
    );
    expect(estimateContextCapacityTokens(inputs)).toBeGreaterThan(
      estimateTokenCount(
        {
          systemPrompt: inputs.systemPrompt,
          documentContext: inputs.documentContext,
          ragContext: null,
          messages: [
            { role: "user", content: "Question." },
            { role: "assistant", content: "Readable." },
          ],
        },
        inputs.draft,
      ),
    );
  });
});

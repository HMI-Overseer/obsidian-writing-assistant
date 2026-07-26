import { describe, expect, it } from "vitest";
import type {
  AssistantReplayEvidence,
  AssistantTurnRecord,
  ToolActionLedgerEntry,
} from "../../../../src/shared/types";
import {
  createAssistantTurnMessage,
  createAssistantTurnRevision,
} from "../../../../src/chat/finalization/assistantTurnFinalization";

const replayEvidence: AssistantReplayEvidence = {
  tier: "structural",
  capabilities: {
    captureOrder: "exact",
    toolCorrelation: "provider_id",
    coldReplay: "structural",
    nativeResume: false,
  },
};

function turn(
  status: AssistantTurnRecord["status"],
  text = "",
): AssistantTurnRecord {
  return {
    schemaVersion: 1,
    id: "turn-1",
    status,
    segments: text ? [{ id: "segment-1" }] : [],
    items: text
      ? [{
          type: "prose",
          id: "item-1",
          segmentId: "segment-1",
          text,
        }]
      : [],
  };
}

describe("assistant turn finalization", () => {
  it.each([
    ["completed", "", false, false],
    ["interrupted", "partial", false, true],
    ["failed", "partial", true, false],
  ] as const)(
    "persists a %s turn revision even when prose is empty",
    (status, text, isError, interrupted) => {
      const revision = createAssistantTurnRevision({
        revisionId: "revision-1",
        origin: "generated",
        createdAt: 10,
        provider: "anthropic",
        modelId: "claude-test",
        turn: turn(status, text),
        replayEvidence,
        isError,
        interrupted,
        errorMessage: isError ? "stream failed" : undefined,
      });
      const message = createAssistantTurnMessage({
        messageId: "message-1",
        revision,
        actionLedger: [],
      });

      expect(message.id).toBe("message-1");
      expect(message.content).toBe(text);
      expect(message.revisions).toEqual([revision]);
      expect(message.activeRevisionId).toBe("revision-1");
      expect(message.actionLedger).toEqual([]);
      expect(message).not.toHaveProperty("agenticSteps");
      expect(message).not.toHaveProperty("toolCalls");
      expect(message).not.toHaveProperty("editProposals");
      expect(message).not.toHaveProperty("appliedEdits");
      expect(message).not.toHaveProperty("vaultOpProposal");
      expect(message).not.toHaveProperty("appliedVaultOps");
    },
  );

  it("keeps the ledger as the sole owner of review state", () => {
    const ledger = [{
      actionRef: "action-1",
      revisionId: "revision-1",
      family: "memory",
      placement: {
        state: "placed",
        anchor: "tool_call",
        itemId: "tool-item-1",
        correlation: { kind: "provider_id", toolCallId: "call-1" },
      },
      payload: {
        targets: [{
          targetId: "memory-target-1",
          mutation: {
            kind: "forget",
            name: "old-rule",
          },
        }],
      },
      events: [{
        eventId: "event-1",
        type: "proposed",
        targetId: "memory-target-1",
        createdAt: 10,
      }],
    }] satisfies ToolActionLedgerEntry[];
    const revision = createAssistantTurnRevision({
      revisionId: "revision-1",
      origin: "generated",
      createdAt: 10,
      provider: "openai",
      modelId: "gpt-test",
      turn: turn("completed", "Done"),
      replayEvidence,
    });

    const message = createAssistantTurnMessage({
      messageId: "message-1",
      revision,
      actionLedger: ledger,
    });

    expect(message.actionLedger).toEqual(ledger);
    expect(message.actionLedger).not.toBe(ledger);
    expect(message).not.toHaveProperty("editProposals");
    expect(message).not.toHaveProperty("appliedEdits");
    expect(message).not.toHaveProperty("vaultOpProposal");
    expect(message).not.toHaveProperty("appliedVaultOps");
  });
});

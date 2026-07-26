import { describe, expect, it } from "vitest";
import { hasAmbiguousLegacyReviewOwnership } from "../../../../src/chat/finalization/finalizeEditResponse";
import type { ConversationMessage } from "../../../../src/shared/types";

function message(
  overrides: Partial<ConversationMessage> = {},
): ConversationMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    content: "Fixture.",
    ...overrides,
  };
}

describe("legacy review ownership", () => {
  it("makes content-only multi-version review fields read-only", () => {
    expect(
      hasAmbiguousLegacyReviewOwnership(
        message({
          versions: [
            { content: "First.", createdAt: 1 },
            { content: "Second.", createdAt: 2 },
          ],
          activeVersionIndex: 1,
        }),
      ),
    ).toBe(true);
  });

  it("keeps a single legacy snapshot attributable and canonical ledgers authoritative", () => {
    expect(hasAmbiguousLegacyReviewOwnership(message())).toBe(false);
    expect(
      hasAmbiguousLegacyReviewOwnership(
        message({
          revisions: [
            {
              revisionId: "revision-1",
              kind: "legacy",
              content: "First.",
            },
            {
              revisionId: "revision-2",
              kind: "legacy",
              content: "Second.",
            },
          ],
          activeRevisionId: "revision-2",
          actionLedger: [
            {
              actionRef: "action-1",
              revisionId: "revision-2",
              family: "memory",
              placement: {
                state: "unplaced",
                correlation: {
                  kind: "none",
                  transport: "legacy",
                  reason: "ownership proven by migration",
                },
                reason: "correlation_unavailable",
              },
              payload: {
                targets: [
                  {
                    targetId: "target-1",
                    mutation: {
                      kind: "forget",
                      name: "fixture-memory",
                    },
                  },
                ],
              },
              events: [
                {
                  eventId: "proposed-1",
                  type: "proposed",
                  targetId: "target-1",
                  createdAt: 1,
                },
              ],
            },
          ],
        }),
      ),
    ).toBe(false);
  });
});

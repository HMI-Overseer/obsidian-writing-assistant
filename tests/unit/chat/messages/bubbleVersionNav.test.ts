import { describe, expect, it } from "vitest";
import {
  getVersionNavigationState,
} from "../../../../src/chat/messages/BubbleVersionNav";
import type { ConversationMessage } from "../../../../src/shared/types";

describe("getVersionNavigationState", () => {
  it("uses revision count and active revision ID instead of stale legacy indices", () => {
    const message: ConversationMessage = {
      id: "assistant-1",
      role: "assistant",
      content: "Second.",
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
      activeRevisionId: "revision-1",
      actionLedger: [],
      versions: [
        { content: "stale one", createdAt: 1 },
        { content: "stale two", createdAt: 2 },
      ],
      activeVersionIndex: 1,
    };

    expect(getVersionNavigationState(message)).toEqual({
      activeIndex: 0,
      total: 2,
      nextRevisionId: "revision-2",
    });
  });

  it("requires normalized revisions instead of reading legacy version fields", () => {
    const message: ConversationMessage = {
      id: "assistant-1",
      role: "assistant",
      content: "Second.",
      versions: [
        { content: "First.", createdAt: 1 },
        { content: "Second.", createdAt: 2 },
      ],
      activeVersionIndex: 1,
    };

    expect(getVersionNavigationState(message)).toBeNull();
  });

  it("returns null for one revision or a broken active revision pointer", () => {
    const one: ConversationMessage = {
      id: "assistant-1",
      role: "assistant",
      content: "Only.",
      revisions: [
        {
          revisionId: "revision-1",
          kind: "legacy",
          content: "Only.",
        },
      ],
      activeRevisionId: "revision-1",
      actionLedger: [],
    };
    const broken = {
      ...one,
      revisions: [
        ...one.revisions!,
        {
          revisionId: "revision-2",
          kind: "legacy" as const,
          content: "Other.",
        },
      ],
      activeRevisionId: "missing",
    };

    expect(getVersionNavigationState(one)).toBeNull();
    expect(getVersionNavigationState(broken)).toBeNull();
  });
});

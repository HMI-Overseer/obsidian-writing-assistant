import { describe, test, expect, vi } from "vitest";
import { ChatTranscript } from "../../../src/chat/messages/ChatTranscript";
import type { ConversationMessage } from "../../../src/shared/types";

function makeMessage(id: string, content = id): ConversationMessage {
  return {
    id,
    role: "assistant",
    content,
  };
}

function makeTranscript(): ChatTranscript {
  const owner = {
    registerDomEvent: vi.fn(),
    addChild: vi.fn(),
    removeChild: vi.fn(),
  };
  const refs = {
    messagesEl: {
      scrollTop: 0,
      scrollHeight: 100,
      clientHeight: 100,
    },
    emptyStateEl: {},
  };

  return new ChatTranscript(owner as never, {} as never, refs as never);
}

describe("ChatTranscript.renderMessages", () => {
  test("falls back to full render when message IDs are unchanged", async () => {
    const transcript = makeTranscript();
    const fullRender = vi.fn().mockResolvedValue(undefined);
    const incrementalRender = vi.fn().mockResolvedValue(undefined);

    (transcript as unknown as { fullRender: typeof fullRender }).fullRender = fullRender;
    (transcript as unknown as { incrementalRender: typeof incrementalRender }).incrementalRender =
      incrementalRender;
    (transcript as unknown as { renderedMessageIds: string[] }).renderedMessageIds = ["msg-1"];

    await transcript.renderMessages([makeMessage("msg-1", "edited content")]);

    expect(fullRender).toHaveBeenCalledOnce();
    expect(incrementalRender).not.toHaveBeenCalled();
  });

  test("uses incremental render when new messages are appended", async () => {
    const transcript = makeTranscript();
    const fullRender = vi.fn().mockResolvedValue(undefined);
    const incrementalRender = vi.fn().mockResolvedValue(undefined);

    (transcript as unknown as { fullRender: typeof fullRender }).fullRender = fullRender;
    (transcript as unknown as { incrementalRender: typeof incrementalRender }).incrementalRender =
      incrementalRender;
    (transcript as unknown as { renderedMessageIds: string[] }).renderedMessageIds = ["msg-1"];

    await transcript.renderMessages([
      makeMessage("msg-1", "original content"),
      makeMessage("msg-2", "new content"),
    ]);

    expect(incrementalRender).toHaveBeenCalledOnce();
    expect(fullRender).not.toHaveBeenCalled();
  });
});

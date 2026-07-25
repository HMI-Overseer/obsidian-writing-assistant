import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  finalizeResponse,
} from "../../../../src/chat/finalization/finalizeResponse";
import type { ChatSessionStore } from "../../../../src/chat/conversation/ChatSessionStore";
import type { ChatTranscript } from "../../../../src/chat/messages/ChatTranscript";
import { StreamingRenderer } from "../../../../src/chat/streaming/StreamingRenderer";
import type { BubbleRefs } from "../../../../src/chat/types";
import type WritingAssistantChat from "../../../../src/main";
import type { AgenticStep, ConversationMessage } from "../../../../src/shared/types";

function guidanceSteps(): AgenticStep[] {
  return [
    {
      type: "tool_call",
      round: 0,
      toolName: "ask_user",
      askStatus: "completed",
      askGuidance: {
        questions: [
          {
            question: "Format",
            header: "Output",
            answer: "Detailed",
          },
        ],
      },
    },
  ];
}

function harness() {
  const messages: ConversationMessage[] = [];
  const store = {
    appendMessage: vi.fn((message: ConversationMessage) => messages.push(message)),
    setLastAssistantResponse: vi.fn(),
  } as unknown as ChatSessionStore;
  const transcript = {
    registerBubble: vi.fn(),
    renderPlainTextContent: vi.fn(),
    renderBubbleContent: vi.fn(() => Promise.resolve()),
  } as unknown as ChatTranscript;
  const bubble = {
    bodyEl: { addClass: vi.fn(), removeClass: vi.fn() },
    contentEl: { isConnected: false },
  } as unknown as BubbleRefs;
  return {
    messages,
    store,
    transcript,
    bubble,
    renderer: new StreamingRenderer(bubble, transcript),
  };
}

describe("ask guidance finalization", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      setTimeout: () => 0,
      clearTimeout: () => undefined,
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("persists a zero-text normal response only when completed guidance exists", async () => {
    const withGuidance = harness();
    await finalizeResponse(
      withGuidance.store,
      withGuidance.transcript,
      withGuidance.bubble,
      withGuidance.renderer,
      false,
      {} as WritingAssistantChat,
      "gpt-5",
      "openai",
      null,
      undefined,
      undefined,
      guidanceSteps(),
    );

    expect(withGuidance.messages).toHaveLength(1);
    expect(withGuidance.messages[0]).toMatchObject({
      content: "",
      agenticSteps: guidanceSteps(),
    });

    const ordinary = harness();
    await finalizeResponse(
      ordinary.store,
      ordinary.transcript,
      ordinary.bubble,
      ordinary.renderer,
      false,
      {} as WritingAssistantChat,
      "gpt-5",
      "openai",
    );
    expect(ordinary.messages).toHaveLength(0);
  });
});

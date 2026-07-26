import { describe, it, expect, vi } from "vitest";
import { finalizeAbortedResponse } from "../../../../src/chat/finalization/finalizeResponse";
import type { ChatSessionStore } from "../../../../src/chat/conversation/ChatSessionStore";
import type { ChatTranscript } from "../../../../src/chat/messages/ChatTranscript";
import type { AssistantBubbleRefs } from "../../../../src/chat/types";
import type { AgenticStep, ConversationMessage } from "../../../../src/shared/types";

/**
 * Phase 1 (claude-code cold-rebuild fidelity): a stopped claudecode turn now
 * persists its aborted assistant message ALWAYS, even with zero text, so the
 * transcript carries the empty assistant turn the live session already banked in
 * its watermark (section 6.1 / question 7). Other providers keep today's behavior.
 */

function makeStore() {
  const messages: ConversationMessage[] = [];
  const appendMessage = vi.fn((m: ConversationMessage) => {
    messages.push(m);
  });
  const setLastAssistantResponse = vi.fn();
  const store = { appendMessage, setLastAssistantResponse } as unknown as ChatSessionStore;
  return { store, messages, appendMessage, setLastAssistantResponse };
}

function makeTranscript() {
  const t = {
    registerBubble: vi.fn(),
    renderPlainTextContent: vi.fn(),
    renderBubbleContent: vi.fn(() => Promise.resolve()),
    scrollToBottom: vi.fn(),
  };
  return t;
}

function makeBubble(): AssistantBubbleRefs {
  return {
    role: "assistant",
    rowEl: {},
    columnEl: {},
    chromeEl: {},
    turnHostEl: {},
    turnView: {
      refreshLegacy: vi.fn(() => Promise.resolve()),
    },
  } as unknown as AssistantBubbleRefs;
}

describe("finalizeAbortedResponse", () => {
  it("persists an empty assistant message with partial steps for a stopped claudecode turn", async () => {
    const { store, messages } = makeStore();
    const transcript = makeTranscript();
    const bubble = makeBubble();
    const steps: AgenticStep[] = [{ type: "tool_call", round: 0, toolName: "read_file" }];

    await finalizeAbortedResponse(
      store,
      transcript as unknown as ChatTranscript,
      bubble,
      "",
      "claude-sonnet-4-6",
      "claudecode",
      undefined,
      undefined,
      steps,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "assistant", content: "", agenticSteps: steps });
    expect(bubble.turnView.refreshLegacy).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "interrupted",
        content: "",
      }),
    );
  });

  it("does not persist an empty assistant message for a non-claudecode stopped turn", async () => {
    const { store, messages, appendMessage } = makeStore();
    const transcript = makeTranscript();
    const bubble = makeBubble();
    await finalizeAbortedResponse(
      store,
      transcript as unknown as ChatTranscript,
      bubble,
      "",
      "some-local-model",
      "lmstudio",
    );

    // Scope guard: only claudecode grows an empty turn; other providers do not.
    expect(appendMessage).not.toHaveBeenCalled();
    expect(messages).toHaveLength(0);
    expect(bubble.turnView.refreshLegacy).toHaveBeenCalledWith(
      expect.objectContaining({ status: "interrupted", content: "" }),
    );
  });

  it("persists an empty interrupted direct turn when completed ask guidance exists", async () => {
    const { store, messages } = makeStore();
    const transcript = makeTranscript();
    const bubble = makeBubble();
    const steps: AgenticStep[] = [
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

    await finalizeAbortedResponse(
      store,
      transcript as unknown as ChatTranscript,
      bubble,
      "",
      "gpt-5",
      "openai",
      undefined,
      undefined,
      steps,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      content: "",
      interrupted: true,
      agenticSteps: steps,
    });
  });

  it("persists the aborted content verbatim as the concatenated stream deltas (claudecode)", async () => {
    const { store, messages } = makeStore();
    const transcript = makeTranscript();
    const bubble = makeBubble();
    const response = "Once upon a time";

    await finalizeAbortedResponse(
      store,
      transcript as unknown as ChatTranscript,
      bubble,
      response,
      "claude-sonnet-4-6",
      "claudecode",
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("Once upon a time");
  });
});

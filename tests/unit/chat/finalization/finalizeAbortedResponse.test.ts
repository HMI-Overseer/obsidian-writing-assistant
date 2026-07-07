import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { finalizeAbortedResponse } from "../../../../src/chat/finalization/finalizeResponse";
import { StreamingRenderer } from "../../../../src/chat/streaming/StreamingRenderer";
import type { ChatSessionStore } from "../../../../src/chat/conversation/ChatSessionStore";
import type { ChatTranscript } from "../../../../src/chat/messages/ChatTranscript";
import type { BubbleRefs } from "../../../../src/chat/types";
import type { AgenticStep, ConversationMessage } from "../../../../src/shared/types";

/**
 * Phase 1 (claude-code cold-rebuild fidelity): a stopped claudecode turn now
 * persists its aborted assistant message ALWAYS, even with zero text, so the
 * transcript carries the empty assistant turn the live session already banked in
 * its watermark (§6.1 / question 7). Other providers keep today's behavior.
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

function makeBubble(): BubbleRefs {
  return {
    bodyEl: { addClass: vi.fn(), removeClass: vi.fn() },
    contentEl: { isConnected: false },
  } as unknown as BubbleRefs;
}

describe("finalizeAbortedResponse", () => {
  beforeEach(() => {
    // The real StreamingRenderer schedules a debounced markdown render via
    // window.setTimeout; a no-op timer keeps getCurrentRoundResponse() (pure
    // delta concatenation) the only observable behavior.
    vi.stubGlobal("window", { setTimeout: () => 0, clearTimeout: () => undefined });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("persists an empty assistant message with partial steps for a stopped claudecode turn", async () => {
    const { store, messages } = makeStore();
    const transcript = makeTranscript();
    const bubble = makeBubble();
    // No deltas → getCurrentRoundResponse() === "" → the stopped-generation branch.
    const renderer = new StreamingRenderer(bubble, transcript as unknown as ChatTranscript);
    const steps: AgenticStep[] = [{ type: "tool_call", round: 0, toolName: "read_file" }];

    await finalizeAbortedResponse(
      store,
      transcript as unknown as ChatTranscript,
      bubble,
      renderer,
      "claude-sonnet-4-6",
      "claudecode",
      undefined,
      undefined,
      steps,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "assistant", content: "", agenticSteps: steps });
    // The muted "Generation stopped." bubble still renders.
    expect(transcript.renderPlainTextContent).toHaveBeenCalledWith(bubble, "Generation stopped.");
    expect(bubble.bodyEl.addClass).toHaveBeenCalledWith("is-muted");
  });

  it("does not persist an empty assistant message for a non-claudecode stopped turn", async () => {
    const { store, messages, appendMessage } = makeStore();
    const transcript = makeTranscript();
    const bubble = makeBubble();
    const renderer = new StreamingRenderer(bubble, transcript as unknown as ChatTranscript);

    await finalizeAbortedResponse(
      store,
      transcript as unknown as ChatTranscript,
      bubble,
      renderer,
      "some-local-model",
      "lmstudio",
    );

    // Scope guard: only claudecode grows an empty turn; other providers do not.
    expect(appendMessage).not.toHaveBeenCalled();
    expect(messages).toHaveLength(0);
    // The muted placeholder still shows.
    expect(transcript.renderPlainTextContent).toHaveBeenCalledWith(bubble, "Generation stopped.");
  });

  it("persists the aborted content verbatim as the concatenated stream deltas (claudecode)", async () => {
    const { store, messages } = makeStore();
    const transcript = makeTranscript();
    const bubble = makeBubble();
    const renderer = new StreamingRenderer(bubble, transcript as unknown as ChatTranscript);

    // Cross-module pin: renderer → finalizeAbortedResponse → store. The persisted
    // content must equal the exact concatenation of the streamed deltas, the
    // byte-equality the interrupt watermark relies on (§6.1).
    renderer.appendDelta("Once upon ");
    renderer.appendDelta("a time");

    await finalizeAbortedResponse(
      store,
      transcript as unknown as ChatTranscript,
      bubble,
      renderer,
      "claude-sonnet-4-6",
      "claudecode",
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("Once upon a time");
    renderer.destroy();
  });
});

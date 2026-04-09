import { describe, test, expect, vi } from "vitest";
import { rewriteQueryForRetrieval } from "../../../src/rag/queryRewriter";
import type { ChatClient } from "../../../src/api/chatClient";
import type { ChatTurn } from "../../../src/shared/chatRequest";

function mockClient(responseText: string): ChatClient {
  return {
    complete: vi.fn().mockResolvedValue({ text: responseText, usage: null }),
    stream: vi.fn(),
  };
}

function turn(role: "user" | "assistant" | "tool", content: string | null): ChatTurn {
  return { role, content };
}

describe("rewriteQueryForRetrieval", () => {
  test("returns raw query on first turn (single message)", async () => {
    const client = mockClient("should not be called");
    const messages: ChatTurn[] = [turn("user", "Tell me about Will")];

    const result = await rewriteQueryForRetrieval("Tell me about Will", messages, client, "model-1");

    expect(result).toBe("Tell me about Will");
    expect(client.complete).not.toHaveBeenCalled();
  });

  test("returns raw query when no messages", async () => {
    const client = mockClient("should not be called");

    const result = await rewriteQueryForRetrieval("Tell me about Will", [], client, "model-1");

    expect(result).toBe("Tell me about Will");
    expect(client.complete).not.toHaveBeenCalled();
  });

  test("calls LLM with user history only (no assistant responses)", async () => {
    const client = mockClient("Will's relationship with Strife during the siege");
    const messages: ChatTurn[] = [
      turn("user", "Tell me about Will"),
      turn("assistant", "Will is a central character known for his determination..."),
      turn("user", "What about his relationship with her during the siege?"),
    ];

    const result = await rewriteQueryForRetrieval(
      "What about his relationship with her during the siege?",
      messages,
      client,
      "model-1",
    );

    expect(result).toBe("Will's relationship with Strife during the siege");
    expect(client.complete).toHaveBeenCalledOnce();

    const request = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const content: string = request.messages[0].content;

    // Should contain the prior user message as context
    expect(content).toContain("Tell me about Will");
    // Should contain the current query as follow-up
    expect(content).toContain("What about his relationship with her during the siege?");
    // Should NOT contain the assistant response
    expect(content).not.toContain("Will is a central character");
  });

  test("falls back to raw query on LLM error", async () => {
    const client: ChatClient = {
      complete: vi.fn().mockRejectedValue(new Error("network error")),
      stream: vi.fn(),
    };
    const messages: ChatTurn[] = [
      turn("user", "Tell me about Will"),
      turn("assistant", "Will is..."),
      turn("user", "What did he do next?"),
    ];

    const result = await rewriteQueryForRetrieval("What did he do next?", messages, client, "model-1");

    expect(result).toBe("What did he do next?");
  });

  test("falls back to raw query on empty LLM response", async () => {
    const client = mockClient("   ");
    const messages: ChatTurn[] = [
      turn("user", "Tell me about Will"),
      turn("assistant", "Will is..."),
      turn("user", "What did he do next?"),
    ];

    const result = await rewriteQueryForRetrieval("What did he do next?", messages, client, "model-1");

    expect(result).toBe("What did he do next?");
  });

  test("limits history window to 3 user turns before final message", async () => {
    const client = mockClient("rewritten query");
    const messages: ChatTurn[] = [
      turn("user", "Turn 1"),
      turn("assistant", "Response 1"),
      turn("user", "Turn 2"),
      turn("assistant", "Response 2"),
      turn("user", "Turn 3"),
      turn("assistant", "Response 3"),
      turn("user", "Turn 4"),
      turn("assistant", "Response 4"),
      turn("user", "Turn 5"),
      turn("assistant", "Response 5"),
      turn("user", "Current question"),
    ];

    await rewriteQueryForRetrieval("Current question", messages, client, "model-1");

    const request = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const content: string = request.messages[0].content;

    // Window of 3 user turns before the final: Turn 3, Turn 4, Turn 5
    expect(content).toContain("Turn 3");
    expect(content).toContain("Turn 4");
    expect(content).toContain("Turn 5");

    // Should NOT include earlier user turns
    expect(content).not.toContain("Turn 1");
    expect(content).not.toContain("Turn 2");

    // Should NOT include any assistant responses
    expect(content).not.toContain("Response 3");
    expect(content).not.toContain("Response 4");
    expect(content).not.toContain("Response 5");
  });

  test("filters out tool and assistant turns — only user turns in context", async () => {
    const client = mockClient("rewritten query");
    const messages: ChatTurn[] = [
      turn("user", "Edit the document"),
      turn("assistant", "I'll make changes..."),
      turn("tool", "Tool result content"),
      turn("assistant", "Done editing."),
      turn("user", "What did you change?"),
    ];

    await rewriteQueryForRetrieval("What did you change?", messages, client, "model-1");

    const request = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const content: string = request.messages[0].content;

    expect(content).toContain("Edit the document");
    expect(content).not.toContain("Tool result content");
    expect(content).not.toContain("I'll make changes");
    expect(content).not.toContain("Done editing.");
  });

  test("filters out user turns with null content", async () => {
    const client = mockClient("rewritten query");
    const messages: ChatTurn[] = [
      turn("user", "Tell me about Will"),
      turn("user", null),
      turn("user", "What about Strife?"),
    ];

    await rewriteQueryForRetrieval("What about Strife?", messages, client, "model-1");

    const request = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const content: string = request.messages[0].content;

    expect(content).toContain("Tell me about Will");
    expect(content).not.toContain("null");
  });

  test("uses low temperature and bounded maxTokens", async () => {
    const client = mockClient("rewritten query");
    const messages: ChatTurn[] = [
      turn("user", "Tell me about Will"),
      turn("assistant", "Will is..."),
      turn("user", "What next?"),
    ];

    await rewriteQueryForRetrieval("What next?", messages, client, "model-1");

    const params = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(params.temperature).toBe(0);
    expect(params.maxTokens).toBe(150);
  });

  test("passes signal to complete call", async () => {
    const client = mockClient("rewritten query");
    const controller = new AbortController();
    const messages: ChatTurn[] = [
      turn("user", "Tell me about Will"),
      turn("assistant", "Will is..."),
      turn("user", "What next?"),
    ];

    await rewriteQueryForRetrieval("What next?", messages, client, "model-1", controller.signal);

    const signal = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(signal).toBe(controller.signal);
  });
});

import { describe, test, expect } from "vitest";
import { estimateTokenCount } from "../../../src/shared/tokenEstimation";
import type { ChatRequest } from "../../../src/shared/chatRequest";

function makeRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    systemPrompt: "",
    documentContext: null,
    messages: [],
    ...overrides,
  };
}

describe("estimateTokenCount", () => {
  test("returns 0 for empty request", () => {
    expect(estimateTokenCount(makeRequest())).toBe(0);
  });

  test("estimates tokens for system prompt only", () => {
    const prompt = "You are a helpful assistant."; // 28 chars
    const result = estimateTokenCount(makeRequest({ systemPrompt: prompt }));
    expect(result).toBe(Math.ceil(28 / 4));
  });

  test("includes document context in estimate", () => {
    const request = makeRequest({
      documentContext: {
        filePath: "notes/test.md",
        content: "A".repeat(400),
        isFull: false,
      },
    });
    const result = estimateTokenCount(request);
    // 400 content chars + ~43 label overhead (filePath.length + 30)
    const expectedChars = 400 + "notes/test.md".length + 30;
    expect(result).toBe(Math.ceil(expectedChars / 4));
  });

  test("sums all message content lengths", () => {
    const request = makeRequest({
      messages: [
        { role: "user", content: "Hello there" },         // 11 chars
        { role: "assistant", content: "Hi! How can I help?" }, // 19 chars
        { role: "user", content: "Write something" },      // 15 chars
      ],
    });
    const result = estimateTokenCount(request);
    expect(result).toBe(Math.ceil((11 + 19 + 15) / 4));
  });

  test("combines all components", () => {
    const systemPrompt = "Be helpful."; // 11 chars
    const docContent = "B".repeat(200);
    const filePath = "doc.md";
    const request = makeRequest({
      systemPrompt,
      documentContext: { filePath, content: docContent, isFull: true },
      messages: [
        { role: "user", content: "C".repeat(100) },
        { role: "assistant", content: "D".repeat(80) },
      ],
    });
    const result = estimateTokenCount(request);
    const expectedChars = 11 + (filePath.length + 30 + 200) + 100 + 80;
    expect(result).toBe(Math.ceil(expectedChars / 4));
  });

  test("rounds up to nearest integer", () => {
    // 5 chars / 4 = 1.25 → should be 2
    const request = makeRequest({ systemPrompt: "Hello" });
    expect(result(request)).toBe(2);

    function result(req: ChatRequest): number {
      return estimateTokenCount(req);
    }
  });
});

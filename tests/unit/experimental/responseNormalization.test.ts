import { describe, expect, it } from "vitest";
import {
  TOOL_RESULT_CONTROL_TOKEN_PREFIX,
  TOOL_RESULT_CONTROL_TOKEN_PREFIX_NORMALIZER,
} from "../../../experimental/candidates/toolResultControlTokenPrefix";
import type { CompletionResult } from "../../../src/api/usageTypes";
import type { ChatRequest, ChatTurn } from "../../../src/shared/chatRequest";

function request(lastTurn: ChatTurn): ChatRequest {
  return {
    systemPrompt: "",
    documentContext: null,
    ragContext: null,
    messages: [{ role: "user", content: "Test" }, lastTurn],
  };
}

function completion(text: string): CompletionResult {
  return { text, usage: null, toolCalls: null, stopReason: "end_turn" };
}

function normalize(text: string, lastTurn: ChatTurn = {
  role: "tool",
  content: "result",
  toolCallId: "call-1",
}): string {
  return TOOL_RESULT_CONTROL_TOKEN_PREFIX_NORMALIZER.normalize(
    request(lastTurn),
    completion(text),
  ).text;
}

describe("tool-result control-token prefix normalizer", () => {
  it("removes one exact confirmed prefix after a tool result", () => {
    expect(normalize(`${TOOL_RESULT_CONTROL_TOKEN_PREFIX}Grounded answer`)).toBe("Grounded answer");
  });

  it("preserves clean response text", () => {
    expect(normalize("Mara carries a brass compass.")).toBe("Mara carries a brass compass.");
  });

  it.each([
    "<|channel>thought <channel|>Author text",
    "<|channel>analysis\n<channel|>Author text",
    `Preface ${TOOL_RESULT_CONTROL_TOKEN_PREFIX}Author text`,
    "<|channel>thought\r\n<channel|>Author text",
    "<|channel>thought\n<channel|Author text",
  ])("preserves deceptive near-match %j", (text) => {
    expect(normalize(text)).toBe(text);
  });

  it("does not alter the same prefix outside a tool-result continuation", () => {
    const text = `${TOOL_RESULT_CONTROL_TOKEN_PREFIX}Quoted author text`;
    expect(normalize(text, { role: "assistant", content: "previous" })).toBe(text);
  });

  it("removes only one prefix", () => {
    const doubled = TOOL_RESULT_CONTROL_TOKEN_PREFIX.repeat(2) + "Author text";
    expect(normalize(doubled)).toBe(`${TOOL_RESULT_CONTROL_TOKEN_PREFIX}Author text`);
  });
});

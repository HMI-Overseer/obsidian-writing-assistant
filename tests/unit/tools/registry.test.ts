import { describe, test, expect } from "vitest";
import { shouldUseToolCall } from "../../../src/tools/registry";

describe("shouldUseToolCall", () => {
  test("returns true for anthropic provider", () => {
    expect(shouldUseToolCall("anthropic")).toBe(true);
  });

  test("returns true for openai provider", () => {
    expect(shouldUseToolCall("openai")).toBe(true);
  });

  test("returns false for lmstudio without capabilities", () => {
    expect(shouldUseToolCall("lmstudio")).toBe(false);
  });

  test("returns false for lmstudio with trainedForToolUse=false", () => {
    expect(shouldUseToolCall("lmstudio", { trainedForToolUse: false })).toBe(false);
  });

  test("returns true for lmstudio with trainedForToolUse=true", () => {
    expect(shouldUseToolCall("lmstudio", { trainedForToolUse: true })).toBe(true);
  });

  test("returns false for lmstudio with undefined trainedForToolUse", () => {
    expect(shouldUseToolCall("lmstudio", {})).toBe(false);
  });
});

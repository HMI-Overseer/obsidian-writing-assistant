import { describe, it, expect } from "vitest";
import { decorateJinjaTemplateError } from "../../../src/api/LMStudioClient";

// The exact server error from the field (gemma4 fine-tune, 2026-07-06): a broken
// chat-template tools branch 400s every request that carries tool definitions,
// while the model still advertises trained_for_tool_use. The decoration turns LM
// Studio's generic template advice into the plugin-level remedy.
const JINJA_MESSAGE =
  'Error rendering prompt with jinja template: "Cannot call something that is not a function: got UndefinedValue".';

describe("decorateJinjaTemplateError", () => {
  it("appends the tools remedy when the failed request carried tools", () => {
    const decorated = decorateJinjaTemplateError(new Error(JINJA_MESSAGE), true);
    expect(decorated).toBeInstanceOf(Error);
    const message = (decorated as Error).message;
    expect(message).toContain(JINJA_MESSAGE);
    expect(message).toContain("tool definitions");
    expect(message).toContain("Agentic mode");
  });

  it("passes a jinja error through untouched when no tools were sent", () => {
    const original = new Error(JINJA_MESSAGE);
    expect(decorateJinjaTemplateError(original, false)).toBe(original);
  });

  it("passes non-jinja errors through untouched even with tools", () => {
    const original = new Error("HTTP 500: internal error");
    expect(decorateJinjaTemplateError(original, true)).toBe(original);
  });

  it("passes non-Error values through untouched", () => {
    expect(decorateJinjaTemplateError("boom", true)).toBe("boom");
  });
});

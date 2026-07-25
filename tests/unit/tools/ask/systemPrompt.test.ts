import { describe, expect, it } from "vitest";
import {
  ASK_USER_SYSTEM_GUIDANCE,
  buildAskUserSystemPrompt,
} from "../../../../src/tools/ask/systemPrompt";

describe("buildAskUserSystemPrompt", () => {
  it("emits guidance only for an active ask surface with built-in prompts enabled", () => {
    expect(buildAskUserSystemPrompt({
      askUserAvailable: true,
      builtInPromptsEnabled: true,
    })).toBe(ASK_USER_SYSTEM_GUIDANCE);
    expect(buildAskUserSystemPrompt({
      askUserAvailable: false,
      builtInPromptsEnabled: true,
    })).toBe("");
    expect(buildAskUserSystemPrompt({
      askUserAvailable: true,
      builtInPromptsEnabled: false,
    })).toBe("");
  });

  it("covers the RFC control-plane guidance", () => {
    expect(ASK_USER_SYSTEM_GUIDANCE).toContain("materially changes the result");
    expect(ASK_USER_SYSTEM_GUIDANCE).toContain("Search or read the vault");
    expect(ASK_USER_SYSTEM_GUIDANCE).toContain("reversible assumption");
    expect(ASK_USER_SYSTEM_GUIDANCE).toContain("one call");
    expect(ASK_USER_SYSTEM_GUIDANCE).toContain("recommended option first");
    expect(ASK_USER_SYSTEM_GUIDANCE).toContain("Call ask_user alone");
    expect(ASK_USER_SYSTEM_GUIDANCE).toContain("action approval");
    expect(ASK_USER_SYSTEM_GUIDANCE).toContain("secrets");
  });
});

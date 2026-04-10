import { describe, test, expect } from "vitest";
import { buildSamplingParams } from "../../../../src/chat/finalization/buildSamplingParams";
import type { PluginSettings } from "../../../../src/shared/types";

/** Minimal settings stub with only the fields buildSamplingParams reads. */
function makeSettings(overrides: Partial<PluginSettings> = {}): PluginSettings {
  return {
    lmStudioUrl: "",
    bypassCors: true,
    includeNoteContext: false,
    maxContextChars: 0,
    completionModels: [],
    embeddingModels: [],
    commands: [],
    chatHistory: { conversations: [], activeConversationId: null },
    globalSystemPrompt: "",
    globalTemperature: 0.7,
    globalMaxTokens: null,
    globalTopP: null,
    globalTopK: null,
    globalMinP: null,
    globalRepeatPenalty: null,
    globalReasoning: null,
    diffContextLines: 3,
    diffMinMatchConfidence: 0.6,
    ...overrides,
  };
}

describe("buildSamplingParams", () => {
  test("maps default settings to SamplingParams with nulls", () => {
    const result = buildSamplingParams(makeSettings());

    expect(result).toEqual({
      temperature: 0.7,
      maxTokens: null,
      topP: null,
      topK: null,
      minP: null,
      repeatPenalty: null,
      reasoning: null,
    });
  });

  test("maps all populated settings", () => {
    const result = buildSamplingParams(
      makeSettings({
        globalTemperature: 0.3,
        globalMaxTokens: 2048,
        globalTopP: 0.9,
        globalTopK: 40,
        globalMinP: 0.05,
        globalRepeatPenalty: 1.1,
        globalReasoning: "high",
      })
    );

    expect(result).toEqual({
      temperature: 0.3,
      maxTokens: 2048,
      topP: 0.9,
      topK: 40,
      minP: 0.05,
      repeatPenalty: 1.1,
      reasoning: "high",
    });
  });

  test("preserves zero values (not treated as null)", () => {
    const result = buildSamplingParams(
      makeSettings({ globalTemperature: 0, globalMaxTokens: 0 })
    );

    expect(result.temperature).toBe(0);
    expect(result.maxTokens).toBe(0);
  });
});

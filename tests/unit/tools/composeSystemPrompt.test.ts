import { describe, test, expect } from "vitest";
import { composeSystemPrompt } from "../../../src/chat/finalization/prepareApiMessages";
import type { PluginSettings } from "../../../src/shared/types";
import { DEFAULT_ACTIVE_PROFILE_IDS } from "../../../src/constants";

function makeSettings(overrides: Partial<PluginSettings> = {}): PluginSettings {
  return {
    planSystemPromptPrefix: "",
    chatSystemPromptPrefix: "",
    editToolSystemPromptPrefix: "Tool edit prefix.",
    editFallbackSystemPromptPrefix: "Fallback edit prefix.",
    globalSystemPrompt: "",
    // Remaining fields are not used by composeSystemPrompt but needed for type.
    lmStudioUrl: "",
    bypassCors: true,
    providerSettings: {
      lmstudio: { baseUrl: "", bypassCors: true },
      anthropic: { apiKey: "" },
      openai: { apiKey: "", baseUrl: "" },
    },
    includeNoteContext: true,
    maxContextChars: 12000,
    globalTemperature: 0.7,
    globalMaxTokens: null,
    globalTopP: null,
    globalTopK: null,
    globalMinP: null,
    globalRepeatPenalty: null,
    globalReasoning: null,
    providerProfiles: [],
    activeProfileIds: { ...DEFAULT_ACTIVE_PROFILE_IDS },
    completionModels: [],
    embeddingModels: [],
    commands: [],
    chatHistory: { conversations: [], activeConversationId: null },
    diffContextLines: 3,
    diffMinMatchConfidence: 0.7,
    rag: {
      enabled: false,
      activeEmbeddingModelId: null,
      chunkSize: 1500,
      chunkOverlap: 200,
      topK: 5,
      minScore: 0.3,
      excludePatterns: [],
      maxContextChars: 6000,
    },
    knowledgeGraph: {
      enabled: false,
      activeCompletionModelId: null,
      excludePatterns: [],
    },
    ...overrides,
  };
}

describe("composeSystemPrompt", () => {
  test("returns only profile prompt when prefix is empty (conversation mode)", () => {
    const settings = makeSettings();
    expect(composeSystemPrompt("conversation", false, settings, "Be helpful.")).toBe("Be helpful.");
  });

  test("returns only prefix when profile prompt is empty", () => {
    const settings = makeSettings({ editFallbackSystemPromptPrefix: "Edit instructions." });
    expect(composeSystemPrompt("edit", false, settings, "")).toBe("Edit instructions.");
  });

  test("combines prefix and profile prompt with double newline", () => {
    const settings = makeSettings({
      editToolSystemPromptPrefix: "Tool prefix.",
    });
    expect(composeSystemPrompt("edit", true, settings, "User prompt.")).toBe("Tool prefix.\n\nUser prompt.");
  });

  test("returns empty string when both are empty", () => {
    const settings = makeSettings();
    expect(composeSystemPrompt("conversation", false, settings, "")).toBe("");
  });

  test("uses tool prefix in edit mode when useToolUse=true", () => {
    const settings = makeSettings({
      editToolSystemPromptPrefix: "TOOL",
      editFallbackSystemPromptPrefix: "FALLBACK",
    });
    expect(composeSystemPrompt("edit", true, settings, "")).toBe("TOOL");
    expect(composeSystemPrompt("edit", false, settings, "")).toBe("FALLBACK");
  });

  test("uses plan prefix for plan mode", () => {
    const settings = makeSettings({ planSystemPromptPrefix: "Plan prefix." });
    expect(composeSystemPrompt("plan", false, settings, "")).toBe("Plan prefix.");
  });

  test("uses chat prefix for conversation mode", () => {
    const settings = makeSettings({ chatSystemPromptPrefix: "Chat prefix." });
    expect(composeSystemPrompt("conversation", false, settings, "")).toBe("Chat prefix.");
  });
});

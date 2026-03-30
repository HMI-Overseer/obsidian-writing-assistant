import { describe, test, expect } from "vitest";
import type { ProfileSettingsCallbacks } from "../../../src/chat/models/ProfileSettingsPopover";
import type { CompletionModel, AnthropicCacheSettings } from "../../../src/shared/types";

/**
 * Tests that the callback wiring between the profile settings popover and
 * plugin settings works correctly — i.e. when a callback fires, the
 * corresponding setting is updated and "saved".
 *
 * This mirrors the exact wiring in ChatView.onOpen() where callbacks are
 * bound to plugin.settings fields and plugin.saveSettings().
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeSettings {
  completionModels: CompletionModel[];
  globalSystemPrompt: string;
  globalTemperature: number;
  globalMaxTokens: number | null;
  globalTopP: number | null;
  globalTopK: number | null;
  globalMinP: number | null;
  globalRepeatPenalty: number | null;
  globalReasoning: "off" | "low" | "medium" | "high" | "on" | null;
}

function makeSettings(overrides?: Partial<FakeSettings>): FakeSettings {
  return {
    completionModels: [],
    globalSystemPrompt: "",
    globalTemperature: 0.7,
    globalMaxTokens: null,
    globalTopP: null,
    globalTopK: null,
    globalMinP: null,
    globalRepeatPenalty: null,
    globalReasoning: null,
    ...overrides,
  };
}

function makeLMStudioModel(overrides?: Partial<CompletionModel>): CompletionModel {
  return {
    id: "lm-1",
    name: "Test LM Studio Model",
    modelId: "test-model",
    provider: "lmstudio",
    ...overrides,
  };
}

function makeAnthropicModel(overrides?: Partial<CompletionModel>): CompletionModel {
  return {
    id: "ant-1",
    name: "Test Anthropic Model",
    modelId: "claude-sonnet-4-20250514",
    provider: "anthropic",
    ...overrides,
  };
}

/**
 * Builds the callback object using the same pattern as ChatView.onOpen().
 * Returns the callbacks plus a `saveCount` tracker so tests can verify
 * that saveSettings() was called.
 */
function wireCallbacks(
  settings: FakeSettings,
  activeModel: CompletionModel | null
): { callbacks: ProfileSettingsCallbacks; getSaveCount: () => number } {
  let saveCount = 0;
  const saveSettings = async (): Promise<void> => {
    saveCount++;
  };

  const callbacks: ProfileSettingsCallbacks = {
    getActiveModel: () => activeModel,
    onCacheSettingsChange: async (modelId, cacheSettings) => {
      const model = settings.completionModels.find((m) => m.id === modelId);
      if (model) {
        model.anthropicCacheSettings = cacheSettings;
        await saveSettings();
      }
    },
    getParamSettings: () => ({
      globalSystemPrompt: settings.globalSystemPrompt,
      globalTemperature: settings.globalTemperature,
      globalMaxTokens: settings.globalMaxTokens,
      globalTopP: settings.globalTopP,
      globalTopK: settings.globalTopK,
      globalMinP: settings.globalMinP,
      globalRepeatPenalty: settings.globalRepeatPenalty,
      globalReasoning: settings.globalReasoning,
    }),
    onSystemPromptChange: async (value) => {
      settings.globalSystemPrompt = value;
      await saveSettings();
    },
    onTemperatureChange: async (value) => {
      settings.globalTemperature = value;
      await saveSettings();
    },
    onMaxTokensChange: async (value) => {
      settings.globalMaxTokens = value;
      await saveSettings();
    },
    onTopPChange: async (value) => {
      settings.globalTopP = value;
      await saveSettings();
    },
    onTopKChange: async (value) => {
      settings.globalTopK = value;
      await saveSettings();
    },
    onMinPChange: async (value) => {
      settings.globalMinP = value;
      await saveSettings();
    },
    onRepeatPenaltyChange: async (value) => {
      settings.globalRepeatPenalty = value;
      await saveSettings();
    },
    onReasoningChange: async (value) => {
      settings.globalReasoning = value;
      await saveSettings();
    },
  };

  return { callbacks, getSaveCount: () => saveCount };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Profile settings — LM Studio parameter callbacks", () => {
  test("onSystemPromptChange updates globalSystemPrompt", async () => {
    const settings = makeSettings();
    const { callbacks, getSaveCount } = wireCallbacks(settings, makeLMStudioModel());

    await callbacks.onSystemPromptChange("You are a helpful assistant.");

    expect(settings.globalSystemPrompt).toBe("You are a helpful assistant.");
    expect(getSaveCount()).toBe(1);
  });

  test("onTemperatureChange updates globalTemperature", async () => {
    const settings = makeSettings();
    const { callbacks, getSaveCount } = wireCallbacks(settings, makeLMStudioModel());

    await callbacks.onTemperatureChange(0.3);

    expect(settings.globalTemperature).toBe(0.3);
    expect(getSaveCount()).toBe(1);
  });

  test("onMaxTokensChange updates globalMaxTokens", async () => {
    const settings = makeSettings();
    const { callbacks, getSaveCount } = wireCallbacks(settings, makeLMStudioModel());

    await callbacks.onMaxTokensChange(2048);
    expect(settings.globalMaxTokens).toBe(2048);

    await callbacks.onMaxTokensChange(null);
    expect(settings.globalMaxTokens).toBeNull();
    expect(getSaveCount()).toBe(2);
  });

  test("onTopPChange updates globalTopP", async () => {
    const settings = makeSettings();
    const { callbacks } = wireCallbacks(settings, makeLMStudioModel());

    await callbacks.onTopPChange(0.9);
    expect(settings.globalTopP).toBe(0.9);

    await callbacks.onTopPChange(null);
    expect(settings.globalTopP).toBeNull();
  });

  test("onTopKChange updates globalTopK", async () => {
    const settings = makeSettings();
    const { callbacks } = wireCallbacks(settings, makeLMStudioModel());

    await callbacks.onTopKChange(40);
    expect(settings.globalTopK).toBe(40);

    await callbacks.onTopKChange(null);
    expect(settings.globalTopK).toBeNull();
  });

  test("onMinPChange updates globalMinP", async () => {
    const settings = makeSettings();
    const { callbacks } = wireCallbacks(settings, makeLMStudioModel());

    await callbacks.onMinPChange(0.05);
    expect(settings.globalMinP).toBe(0.05);

    await callbacks.onMinPChange(null);
    expect(settings.globalMinP).toBeNull();
  });

  test("onRepeatPenaltyChange updates globalRepeatPenalty", async () => {
    const settings = makeSettings();
    const { callbacks } = wireCallbacks(settings, makeLMStudioModel());

    await callbacks.onRepeatPenaltyChange(1.1);
    expect(settings.globalRepeatPenalty).toBe(1.1);

    await callbacks.onRepeatPenaltyChange(null);
    expect(settings.globalRepeatPenalty).toBeNull();
  });

  test("onReasoningChange updates globalReasoning", async () => {
    const settings = makeSettings();
    const { callbacks } = wireCallbacks(settings, makeLMStudioModel());

    await callbacks.onReasoningChange("high");
    expect(settings.globalReasoning).toBe("high");

    await callbacks.onReasoningChange(null);
    expect(settings.globalReasoning).toBeNull();
  });

  test("getParamSettings returns current values", () => {
    const settings = makeSettings({
      globalSystemPrompt: "test prompt",
      globalTemperature: 0.5,
      globalMaxTokens: 4096,
      globalTopP: 0.95,
      globalTopK: 50,
      globalMinP: 0.01,
      globalRepeatPenalty: 1.2,
      globalReasoning: "medium",
    });
    const { callbacks } = wireCallbacks(settings, makeLMStudioModel());

    const result = callbacks.getParamSettings();

    expect(result).toEqual({
      globalSystemPrompt: "test prompt",
      globalTemperature: 0.5,
      globalMaxTokens: 4096,
      globalTopP: 0.95,
      globalTopK: 50,
      globalMinP: 0.01,
      globalRepeatPenalty: 1.2,
      globalReasoning: "medium",
    });
  });

  test("getParamSettings reflects mutations after callbacks fire", async () => {
    const settings = makeSettings();
    const { callbacks } = wireCallbacks(settings, makeLMStudioModel());

    await callbacks.onTemperatureChange(0.2);
    await callbacks.onMaxTokensChange(1000);

    const result = callbacks.getParamSettings();
    expect(result.globalTemperature).toBe(0.2);
    expect(result.globalMaxTokens).toBe(1000);
  });
});

describe("Profile settings — Anthropic cache callbacks", () => {
  test("onCacheSettingsChange updates model's anthropicCacheSettings", async () => {
    const model = makeAnthropicModel();
    const settings = makeSettings({ completionModels: [model] });
    const { callbacks, getSaveCount } = wireCallbacks(settings, model);

    const newCacheSettings: AnthropicCacheSettings = { enabled: true, ttl: "default" };
    await callbacks.onCacheSettingsChange("ant-1", newCacheSettings);

    expect(model.anthropicCacheSettings).toEqual({ enabled: true, ttl: "default" });
    expect(getSaveCount()).toBe(1);
  });

  test("onCacheSettingsChange with 1h TTL", async () => {
    const model = makeAnthropicModel();
    const settings = makeSettings({ completionModels: [model] });
    const { callbacks } = wireCallbacks(settings, model);

    await callbacks.onCacheSettingsChange("ant-1", { enabled: true, ttl: "1h" });

    expect(model.anthropicCacheSettings).toEqual({ enabled: true, ttl: "1h" });
  });

  test("disabling cache sets enabled to false", async () => {
    const model = makeAnthropicModel({
      anthropicCacheSettings: { enabled: true, ttl: "default" },
    });
    const settings = makeSettings({ completionModels: [model] });
    const { callbacks } = wireCallbacks(settings, model);

    await callbacks.onCacheSettingsChange("ant-1", { enabled: false, ttl: "default" });

    expect(model.anthropicCacheSettings?.enabled).toBe(false);
  });

  test("onCacheSettingsChange does not save if model id not found", async () => {
    const model = makeAnthropicModel();
    const settings = makeSettings({ completionModels: [model] });
    const { callbacks, getSaveCount } = wireCallbacks(settings, model);

    await callbacks.onCacheSettingsChange("nonexistent-id", { enabled: true, ttl: "default" });

    expect(getSaveCount()).toBe(0);
    expect(model.anthropicCacheSettings).toBeUndefined();
  });
});

describe("Profile settings — multiple sequential updates", () => {
  test("rapid setting changes are all persisted in order", async () => {
    const settings = makeSettings();
    const { callbacks, getSaveCount } = wireCallbacks(settings, makeLMStudioModel());

    await callbacks.onTemperatureChange(0.1);
    await callbacks.onTemperatureChange(0.5);
    await callbacks.onTemperatureChange(0.9);

    expect(settings.globalTemperature).toBe(0.9);
    expect(getSaveCount()).toBe(3);
  });

  test("interleaved param and cache updates", async () => {
    const anthropicModel = makeAnthropicModel();
    const settings = makeSettings({
      completionModels: [anthropicModel],
    });
    const { callbacks, getSaveCount } = wireCallbacks(settings, anthropicModel);

    await callbacks.onSystemPromptChange("new prompt");
    await callbacks.onCacheSettingsChange("ant-1", { enabled: true, ttl: "1h" });
    await callbacks.onTemperatureChange(0.4);

    expect(settings.globalSystemPrompt).toBe("new prompt");
    expect(anthropicModel.anthropicCacheSettings).toEqual({ enabled: true, ttl: "1h" });
    expect(settings.globalTemperature).toBe(0.4);
    expect(getSaveCount()).toBe(3);
  });
});

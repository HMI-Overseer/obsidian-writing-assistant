import { describe, test, expect } from "vitest";
import type { ProfileSettingsCallbacks } from "../../../src/chat/models/ProfileSettingsPopover";
import type { CompletionModel, PluginSettings, ProviderProfile } from "../../../src/shared/types";
import { makeDefaultProfile, DEFAULT_ACTIVE_PROFILE_IDS } from "../../../src/constants";
import { getActiveProfile, getProfilesForProvider, generateProfileId } from "../../../src/shared/profileUtils";
import { PROVIDER_DESCRIPTORS } from "../../../src/providers/descriptors";

/**
 * Tests that the callback wiring between the profile settings popover and
 * plugin settings works correctly — i.e. when a callback fires, the
 * corresponding profile/setting is updated and "saved".
 *
 * This mirrors the exact wiring in ChatView.onOpen() where callbacks are
 * bound to plugin.settings fields and plugin.saveSettings().
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeSettings(overrides?: Partial<PluginSettings>): PluginSettings {
  return {
    lmStudioUrl: "",
    bypassCors: true,
    providerSettings: {
      lmstudio: { baseUrl: "", bypassCors: true },
      anthropic: { apiKey: "" },
      openai: { apiKey: "", baseUrl: "" },
    },
    includeNoteContext: true,
    maxContextChars: 12000,
    globalSystemPrompt: "",
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
  } as PluginSettings;
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
 */
function wireCallbacks(
  settings: PluginSettings,
  activeModel: CompletionModel | null,
): { callbacks: ProfileSettingsCallbacks; getSaveCount: () => number } {
  let saveCount = 0;
  const saveSettings = async (): Promise<void> => {
    saveCount++;
  };

  const callbacks: ProfileSettingsCallbacks = {
    getActiveModel: () => activeModel,
    getProfilesForProvider: (provider) =>
      getProfilesForProvider(settings, provider),
    getActiveProfile: (provider) =>
      getActiveProfile(settings, provider),
    getProviderDescriptor: (provider) => PROVIDER_DESCRIPTORS[provider],
    onProfileSelect: async (profileId) => {
      if (!activeModel) return;
      settings.activeProfileIds[activeModel.provider] = profileId;
      await saveSettings();
    },
    onProfileCreate: async (name, provider) => {
      const profile: ProviderProfile = {
        ...makeDefaultProfile(provider),
        id: generateProfileId(provider),
        name,
        isDefault: false,
      };
      settings.providerProfiles.push(profile);
      settings.activeProfileIds[provider] = profile.id;
      await saveSettings();
      return profile;
    },
    onProfileDelete: async (profileId) => {
      const idx = settings.providerProfiles.findIndex((p) => p.id === profileId);
      if (idx === -1) return;
      const deleted = settings.providerProfiles[idx];
      settings.providerProfiles.splice(idx, 1);
      if (settings.activeProfileIds[deleted.provider] === profileId) {
        settings.activeProfileIds[deleted.provider] = `${deleted.provider}-default`;
      }
      await saveSettings();
    },
    onProfileUpdate: async (profileId, patch) => {
      const profile = settings.providerProfiles.find((p) => p.id === profileId);
      if (!profile || profile.isDefault) return;
      Object.assign(profile, patch);
      await saveSettings();
    },
  };

  return { callbacks, getSaveCount: () => saveCount };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Profile settings — profile CRUD callbacks", () => {
  test("onProfileCreate adds a new profile and sets it active", async () => {
    const settings = makeFakeSettings();
    const { callbacks, getSaveCount } = wireCallbacks(settings, makeLMStudioModel());

    const created = await callbacks.onProfileCreate("My Profile", "lmstudio");

    expect(created.name).toBe("My Profile");
    expect(created.provider).toBe("lmstudio");
    expect(created.isDefault).toBe(false);
    expect(settings.providerProfiles).toHaveLength(1);
    expect(settings.activeProfileIds.lmstudio).toBe(created.id);
    expect(getSaveCount()).toBe(1);
  });

  test("onProfileSelect changes the active profile", async () => {
    const settings = makeFakeSettings();
    const { callbacks, getSaveCount } = wireCallbacks(settings, makeLMStudioModel());

    const created = await callbacks.onProfileCreate("Test", "lmstudio");
    await callbacks.onProfileSelect("lmstudio-default");

    expect(settings.activeProfileIds.lmstudio).toBe("lmstudio-default");
    expect(getSaveCount()).toBe(2);

    // Switch back to user profile
    await callbacks.onProfileSelect(created.id);
    expect(settings.activeProfileIds.lmstudio).toBe(created.id);
  });

  test("onProfileDelete removes the profile and resets to default", async () => {
    const settings = makeFakeSettings();
    const { callbacks, getSaveCount } = wireCallbacks(settings, makeLMStudioModel());

    const created = await callbacks.onProfileCreate("Temp", "lmstudio");
    expect(settings.activeProfileIds.lmstudio).toBe(created.id);

    await callbacks.onProfileDelete(created.id);

    expect(settings.providerProfiles).toHaveLength(0);
    expect(settings.activeProfileIds.lmstudio).toBe("lmstudio-default");
    expect(getSaveCount()).toBe(2);
  });

  test("onProfileDelete with non-existent ID does nothing", async () => {
    const settings = makeFakeSettings();
    const { callbacks, getSaveCount } = wireCallbacks(settings, makeLMStudioModel());

    await callbacks.onProfileDelete("nonexistent-id");
    expect(getSaveCount()).toBe(0);
  });

  test("onProfileUpdate patches a user profile", async () => {
    const settings = makeFakeSettings();
    const { callbacks, getSaveCount } = wireCallbacks(settings, makeLMStudioModel());

    const created = await callbacks.onProfileCreate("Custom", "lmstudio");

    await callbacks.onProfileUpdate(created.id, { temperature: 0.3 });

    const updated = settings.providerProfiles.find((p) => p.id === created.id);
    expect(updated?.temperature).toBe(0.3);
    expect(getSaveCount()).toBe(2);
  });

  test("onProfileUpdate refuses to patch a default profile", async () => {
    const settings = makeFakeSettings();
    const { callbacks, getSaveCount } = wireCallbacks(settings, makeLMStudioModel());

    // Attempt to update the default profile (which isn't in providerProfiles array)
    await callbacks.onProfileUpdate("lmstudio-default", { temperature: 0.1 });

    // No save should have occurred
    expect(getSaveCount()).toBe(0);
  });
});

describe("Profile settings — Anthropic cache via profile", () => {
  test("onProfileUpdate updates cache settings on anthropic profile", async () => {
    const settings = makeFakeSettings();
    const { callbacks } = wireCallbacks(settings, makeAnthropicModel());

    const created = await callbacks.onProfileCreate("Cached", "anthropic");

    await callbacks.onProfileUpdate(created.id, {
      anthropicCacheSettings: { enabled: true, ttl: "1h" },
    });

    const profile = settings.providerProfiles.find((p) => p.id === created.id);
    expect(profile?.anthropicCacheSettings).toEqual({ enabled: true, ttl: "1h" });
  });
});

describe("Profile settings — getProfilesForProvider", () => {
  test("returns default profile when no user profiles exist", () => {
    const settings = makeFakeSettings();
    const { callbacks } = wireCallbacks(settings, makeLMStudioModel());

    const profiles = callbacks.getProfilesForProvider("lmstudio");

    expect(profiles).toHaveLength(1);
    expect(profiles[0].isDefault).toBe(true);
    expect(profiles[0].name).toBe("Default");
  });

  test("returns default plus user profiles", async () => {
    const settings = makeFakeSettings();
    const { callbacks } = wireCallbacks(settings, makeLMStudioModel());

    await callbacks.onProfileCreate("Profile A", "lmstudio");
    await callbacks.onProfileCreate("Profile B", "lmstudio");

    const profiles = callbacks.getProfilesForProvider("lmstudio");

    expect(profiles).toHaveLength(3);
    expect(profiles[0].isDefault).toBe(true);
    expect(profiles[1].name).toBe("Profile A");
    expect(profiles[2].name).toBe("Profile B");
  });

  test("profiles are scoped to provider", async () => {
    const settings = makeFakeSettings();
    const { callbacks } = wireCallbacks(settings, makeLMStudioModel());

    await callbacks.onProfileCreate("LM Profile", "lmstudio");
    await callbacks.onProfileCreate("Anthropic Profile", "anthropic");

    expect(callbacks.getProfilesForProvider("lmstudio")).toHaveLength(2);
    expect(callbacks.getProfilesForProvider("anthropic")).toHaveLength(2);
    expect(callbacks.getProfilesForProvider("openai")).toHaveLength(1);
  });
});

describe("Profile settings — getActiveProfile", () => {
  test("returns default profile when no user profile is active", () => {
    const settings = makeFakeSettings();
    const { callbacks } = wireCallbacks(settings, makeLMStudioModel());

    const profile = callbacks.getActiveProfile("lmstudio");

    expect(profile.isDefault).toBe(true);
    expect(profile.id).toBe("lmstudio-default");
  });

  test("returns user profile when one is active", async () => {
    const settings = makeFakeSettings();
    const { callbacks } = wireCallbacks(settings, makeLMStudioModel());

    const created = await callbacks.onProfileCreate("Active", "lmstudio");

    const profile = callbacks.getActiveProfile("lmstudio");
    expect(profile.id).toBe(created.id);
    expect(profile.name).toBe("Active");
  });

  test("falls back to default if active profile ID is stale", () => {
    const settings = makeFakeSettings({
      activeProfileIds: {
        lmstudio: "nonexistent-id",
        anthropic: "anthropic-default",
        openai: "openai-default",
      },
    });
    const { callbacks } = wireCallbacks(settings, makeLMStudioModel());

    const profile = callbacks.getActiveProfile("lmstudio");
    expect(profile.isDefault).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import type { PluginSettings } from "../../../src/shared/types";
import { normalizePluginSettings } from "../../../src/settings/settingsMigration";
import { modelKey, parseModelKey } from "../../../src/shared/modelKeys";

/**
 * Provider enablement + model-identity migration (providers-tab rework).
 *
 * Legacy saved blobs carry `completionModels` / `embeddingModels` arrays with
 * synthetic profile ids. The migration derives per-provider `enabled` flags,
 * seeds the LM Studio last-seen cache and cloud custom-model lists from those
 * rows, records id aliases (old synthetic id → composed `provider:modelId`
 * key), and rewrites stored pointers (RAG / knowledge graph / chat history
 * metas) onto the composed keys.
 */

const LEGACY_LM_ROW = {
  id: "model-1",
  name: "Llama 3",
  modelId: "llama-3-8b",
  provider: "lmstudio" as const,
  contextWindowSize: 8192,
  trainedForToolUse: true,
};

const LEGACY_ANTHROPIC_ROW = {
  id: "model-2",
  name: "My Sonnet",
  modelId: "claude-sonnet-4-6",
  provider: "anthropic" as const,
};

const LEGACY_CUSTOM_ANTHROPIC_ROW = {
  id: "model-3",
  name: "Fine-tune",
  modelId: "claude-custom-ft-123",
  provider: "anthropic" as const,
};

const LEGACY_EMBEDDING_ROW = {
  id: "embedding-1",
  name: "Nomic",
  modelId: "nomic-embed-text-v1.5",
  provider: "lmstudio" as const,
};

function legacyBlob(overrides: Record<string, unknown> = {}): Partial<PluginSettings> {
  return {
    completionModels: [LEGACY_LM_ROW, LEGACY_ANTHROPIC_ROW, LEGACY_CUSTOM_ANTHROPIC_ROW],
    embeddingModels: [LEGACY_EMBEDDING_ROW],
    ...overrides,
  } as unknown as Partial<PluginSettings>;
}

describe("modelKey helpers", () => {
  it("round-trips provider + modelId", () => {
    const key = modelKey("lmstudio", "llama-3-8b");
    expect(key).toBe("lmstudio:llama-3-8b");
    expect(parseModelKey(key)).toEqual({ provider: "lmstudio", modelId: "llama-3-8b" });
  });

  it("rejects keys without a valid provider prefix", () => {
    expect(parseModelKey("model-1")).toBeNull();
    expect(parseModelKey("completion:llama-3-8b")).toBeNull();
    expect(parseModelKey("anthropic:")).toBeNull();
  });
});

describe("provider enabled flag", () => {
  it("defaults keyless providers on and keyed providers off for a fresh install", () => {
    const settings = normalizePluginSettings(null);
    expect(settings.providerSettings.lmstudio.enabled).toBe(true);
    expect(settings.providerSettings.claudecode.enabled).toBe(true);
    expect(settings.providerSettings.anthropic.enabled).toBe(false);
    expect(settings.providerSettings.openai.enabled).toBe(false);
  });

  it("enables a keyed provider on upgrade when a key is stored", () => {
    const settings = normalizePluginSettings({
      providerSettings: {
        anthropic: { apiKey: "sk-ant-xxx" },
      },
    } as unknown as Partial<PluginSettings>);
    expect(settings.providerSettings.anthropic.enabled).toBe(true);
    expect(settings.providerSettings.openai.enabled).toBe(false);
  });

  it("clamps a saved enabled=true on a keyed provider without a key", () => {
    const settings = normalizePluginSettings({
      providerSettings: {
        anthropic: { apiKey: "", enabled: true },
      },
    } as unknown as Partial<PluginSettings>);
    expect(settings.providerSettings.anthropic.enabled).toBe(false);
  });

  it("respects a saved enabled=false even when a key exists", () => {
    const settings = normalizePluginSettings({
      providerSettings: {
        anthropic: { apiKey: "sk-ant-xxx", enabled: false },
      },
    } as unknown as Partial<PluginSettings>);
    expect(settings.providerSettings.anthropic.enabled).toBe(false);
  });
});

describe("legacy model-row migration", () => {
  it("seeds the LM Studio last-seen cache from legacy rows (identity only, no caps)", () => {
    const settings = normalizePluginSettings(legacyBlob());
    expect(settings.lmStudioModelCache.completion).toEqual([
      {
        id: "lmstudio:llama-3-8b",
        name: "Llama 3",
        modelId: "llama-3-8b",
        provider: "lmstudio",
      },
    ]);
    expect(settings.lmStudioModelCache.embedding).toEqual([
      {
        id: "lmstudio:nomic-embed-text-v1.5",
        name: "Nomic",
        modelId: "nomic-embed-text-v1.5",
        provider: "lmstudio",
      },
    ]);
  });

  it("seeds customModels from cloud rows whose modelId is not in the curated catalog", () => {
    const settings = normalizePluginSettings(legacyBlob());
    const custom = settings.customModels.anthropic ?? [];
    // claude-sonnet-4-6 is in the shipped catalog; the fine-tune id is not.
    expect(custom).toEqual([
      { modelId: "claude-custom-ft-123", name: "Fine-tune", role: "completion" },
    ]);
  });

  it("records aliases from every legacy row id to its composed key", () => {
    const settings = normalizePluginSettings(legacyBlob());
    expect(settings.modelIdAliases["model-1"]).toBe("lmstudio:llama-3-8b");
    expect(settings.modelIdAliases["model-2"]).toBe("anthropic:claude-sonnet-4-6");
    expect(settings.modelIdAliases["embedding-1"]).toBe("lmstudio:nomic-embed-text-v1.5");
  });

  it("rewrites RAG, knowledge-graph, and chat-history pointers onto composed keys", () => {
    const settings = normalizePluginSettings(
      legacyBlob({
        rag: { activeEmbeddingModelId: "embedding-1" },
        knowledgeGraph: {
          activeCompletionModelId: "model-1",
          activeEmbeddingModelId: "embedding-1",
        },
        chatHistory: {
          conversations: [
            {
              id: "c1",
              title: "t",
              createdAt: 1,
              updatedAt: 1,
              modelId: "model-2",
              modelName: "My Sonnet",
              messageCount: 0,
            },
          ],
          activeConversationId: "c1",
        },
      }),
    );
    expect(settings.rag.activeEmbeddingModelId).toBe("lmstudio:nomic-embed-text-v1.5");
    expect(settings.knowledgeGraph.activeCompletionModelId).toBe("lmstudio:llama-3-8b");
    expect(settings.knowledgeGraph.activeEmbeddingModelId).toBe("lmstudio:nomic-embed-text-v1.5");
    expect(settings.chatHistory.conversations[0].modelId).toBe("anthropic:claude-sonnet-4-6");
  });

  it("keeps already-migrated data stable (idempotent second pass)", () => {
    const first = normalizePluginSettings(legacyBlob());
    const second = normalizePluginSettings(JSON.parse(JSON.stringify(first)));
    expect(second.lmStudioModelCache).toEqual(first.lmStudioModelCache);
    expect(second.customModels).toEqual(first.customModels);
    expect(second.modelIdAliases).toEqual(first.modelIdAliases);
    expect(second.providerSettings).toEqual(first.providerSettings);
  });
});

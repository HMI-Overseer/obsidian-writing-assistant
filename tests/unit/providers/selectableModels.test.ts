import { describe, it, expect } from "vitest";
import type { PluginSettings } from "../../../src/shared/types";
import { normalizePluginSettings } from "../../../src/settings/settingsMigration";
import {
  getSelectableCompletionModels,
  getSelectableEmbeddingModels,
} from "../../../src/providers/selectableModels";
import { resolveCompletionModel, resolveEmbeddingModel } from "../../../src/utils";

/**
 * Composed model read path: selectable models = enabled cloud providers'
 * curated catalogs + LM Studio's last-seen discovery cache + per-provider
 * custom entries. Every consumer of "what models can I pick" goes through
 * these helpers, so enablement is authoritative, never advisory.
 */

function makeSettings(mutate?: (s: PluginSettings) => void): PluginSettings {
  const settings = normalizePluginSettings(null);
  if (mutate) mutate(settings);
  return settings;
}

describe("getSelectableCompletionModels", () => {
  it("returns only enabled providers' models", () => {
    const settings = makeSettings((s) => {
      s.providerSettings.lmstudio.enabled = true;
      s.providerSettings.claudecode.enabled = false;
      s.lmStudioModelCache.completion = [
        { id: "lmstudio:llama-3-8b", name: "Llama 3", modelId: "llama-3-8b", provider: "lmstudio" },
      ];
    });
    const models = getSelectableCompletionModels(settings);
    expect(models.map((m) => m.id)).toEqual(["lmstudio:llama-3-8b"]);
  });

  it("includes the curated Anthropic catalog when the provider is enabled", () => {
    const settings = makeSettings((s) => {
      s.providerSettings.lmstudio.enabled = false;
      s.providerSettings.claudecode.enabled = false;
      s.providerSettings.anthropic.enabled = true;
    });
    const models = getSelectableCompletionModels(settings);
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.provider === "anthropic")).toBe(true);
    expect(models.every((m) => m.id.startsWith("anthropic:"))).toBe(true);
  });

  it("appends custom models after the catalog and dedupes by id", () => {
    const settings = makeSettings((s) => {
      s.providerSettings.lmstudio.enabled = false;
      s.providerSettings.claudecode.enabled = false;
      s.providerSettings.anthropic.enabled = true;
      s.customModels.anthropic = [
        { modelId: "claude-custom-ft-123", name: "Fine-tune", role: "completion" },
      ];
    });
    const models = getSelectableCompletionModels(settings);
    const custom = models.find((m) => m.modelId === "claude-custom-ft-123");
    expect(custom).toBeDefined();
    expect(custom?.id).toBe("anthropic:claude-custom-ft-123");
    const ids = models.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("getSelectableEmbeddingModels", () => {
  it("returns the LM Studio embedding cache when enabled", () => {
    const settings = makeSettings((s) => {
      s.lmStudioModelCache.embedding = [
        { id: "lmstudio:nomic", name: "Nomic", modelId: "nomic", provider: "lmstudio" },
      ];
    });
    const models = getSelectableEmbeddingModels(settings);
    expect(models.some((m) => m.id === "lmstudio:nomic")).toBe(true);
  });

  it("excludes disabled providers entirely", () => {
    const settings = makeSettings((s) => {
      s.providerSettings.lmstudio.enabled = false;
      s.lmStudioModelCache.embedding = [
        { id: "lmstudio:nomic", name: "Nomic", modelId: "nomic", provider: "lmstudio" },
      ];
    });
    expect(getSelectableEmbeddingModels(settings)).toEqual([]);
  });
});

describe("resolveCompletionModel", () => {
  it("resolves a composed key directly", () => {
    const settings = makeSettings((s) => {
      s.lmStudioModelCache.completion = [
        { id: "lmstudio:llama-3-8b", name: "Llama 3", modelId: "llama-3-8b", provider: "lmstudio" },
      ];
    });
    expect(resolveCompletionModel(settings, "lmstudio:llama-3-8b")?.name).toBe("Llama 3");
  });

  it("resolves a legacy synthetic id through the alias map", () => {
    const settings = makeSettings((s) => {
      s.lmStudioModelCache.completion = [
        { id: "lmstudio:llama-3-8b", name: "Llama 3", modelId: "llama-3-8b", provider: "lmstudio" },
      ];
      s.modelIdAliases["model-1"] = "lmstudio:llama-3-8b";
    });
    expect(resolveCompletionModel(settings, "model-1")?.id).toBe("lmstudio:llama-3-8b");
  });

  it("returns null for a model whose provider is disabled", () => {
    const settings = makeSettings((s) => {
      s.providerSettings.lmstudio.enabled = false;
      s.lmStudioModelCache.completion = [
        { id: "lmstudio:llama-3-8b", name: "Llama 3", modelId: "llama-3-8b", provider: "lmstudio" },
      ];
    });
    expect(resolveCompletionModel(settings, "lmstudio:llama-3-8b")).toBeNull();
  });
});

describe("resolveEmbeddingModel", () => {
  it("resolves composed keys and aliases over the embedding list", () => {
    const settings = makeSettings((s) => {
      s.lmStudioModelCache.embedding = [
        { id: "lmstudio:nomic", name: "Nomic", modelId: "nomic", provider: "lmstudio" },
      ];
      s.modelIdAliases["embedding-1"] = "lmstudio:nomic";
    });
    expect(resolveEmbeddingModel(settings, "lmstudio:nomic")?.name).toBe("Nomic");
    expect(resolveEmbeddingModel(settings, "embedding-1")?.id).toBe("lmstudio:nomic");
  });
});

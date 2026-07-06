import type {
  CompletionModel,
  CustomModelEntry,
  EmbeddingModel,
  ModelRole,
  PluginSettings,
  ProviderOption,
} from "../shared/types";
import { PROVIDER_OPTIONS, modelKey } from "../shared/modelKeys";
import { getCatalogCompletionModels, getCatalogEmbeddingModels } from "./catalog";

/**
 * The composed model read path: `enabled providers' catalogs + LM Studio's
 * last-seen discovery + custom entries`, derived at read time from settings.
 *
 * INVARIANT: every consumer of "what models can I pick" (chat selector, RAG
 * embedding choice, knowledge graph, benchmark) goes through these helpers.
 * Reading any other source would make provider enablement advisory and let a
 * disabled provider's models leak into selection.
 *
 * One source of truth per fact: cloud catalogs ship in code (providers/catalog),
 * local models live in LM Studio (cached last-seen in settings), enablement
 * lives in `providerSettings`.
 */

function customEntriesFor(
  settings: PluginSettings,
  provider: ProviderOption,
  role: ModelRole,
): CustomModelEntry[] {
  return (settings.customModels[provider] ?? []).filter(
    (entry) => entry.role === role && entry.modelId.trim().length > 0,
  );
}

function dedupeById<T extends { id: string }>(models: T[]): T[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

export function getSelectableCompletionModels(settings: PluginSettings): CompletionModel[] {
  const models: CompletionModel[] = [];
  for (const provider of PROVIDER_OPTIONS) {
    if (!settings.providerSettings[provider].enabled) continue;
    if (provider === "lmstudio") {
      models.push(...settings.lmStudioModelCache.completion);
    } else {
      models.push(...getCatalogCompletionModels(provider));
    }
    for (const entry of customEntriesFor(settings, provider, "completion")) {
      models.push({
        id: modelKey(provider, entry.modelId),
        name: entry.name || entry.modelId,
        modelId: entry.modelId,
        provider,
      });
    }
  }
  return dedupeById(models);
}

export function getSelectableEmbeddingModels(settings: PluginSettings): EmbeddingModel[] {
  const models: EmbeddingModel[] = [];
  for (const provider of PROVIDER_OPTIONS) {
    if (!settings.providerSettings[provider].enabled) continue;
    if (provider === "lmstudio") {
      models.push(...settings.lmStudioModelCache.embedding);
    } else {
      models.push(...getCatalogEmbeddingModels(provider));
    }
    for (const entry of customEntriesFor(settings, provider, "embedding")) {
      models.push({
        id: modelKey(provider, entry.modelId),
        name: entry.name || entry.modelId,
        modelId: entry.modelId,
        provider,
      });
    }
  }
  return dedupeById(models);
}

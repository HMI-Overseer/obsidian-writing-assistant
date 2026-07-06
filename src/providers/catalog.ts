import type { CompletionModel, EmbeddingModel, ModelRole, ProviderOption } from "../shared/types";
import { modelKey } from "../shared/modelKeys";
import catalogData from "./catalogData.json";

/**
 * Curated cloud model catalogs, shipped with the plugin and inlined into the
 * bundle. The plugin never fetches a cloud catalog at runtime; the file is
 * regenerated at release time by the build-time sync riding the pricing fetch
 * (scripts/update-pricing.mjs, ADR-0007 pattern), so attribute drift self-heals
 * every release and new upstream models auto-include at version time.
 *
 * LM Studio deliberately has no entry here: its catalog is live discovery
 * (LMStudioModelsService), cached in settings as the last-seen snapshot.
 */

export interface CatalogEntry {
  modelId: string;
  name: string;
  role: ModelRole;
  contextWindowSize?: number;
  vision?: boolean;
}

interface CatalogFile {
  asOf: string;
  source: string;
  providers: Partial<Record<ProviderOption, CatalogEntry[]>>;
}

const CATALOG = catalogData as CatalogFile;

/** Date stamp of the shipped catalog, for "as of <date>" UI qualifiers. */
export const CATALOG_AS_OF: string = CATALOG.asOf;

export function getCatalogEntries(provider: ProviderOption): CatalogEntry[] {
  return CATALOG.providers[provider] ?? [];
}

function toCompletionModel(provider: ProviderOption, entry: CatalogEntry): CompletionModel {
  return {
    id: modelKey(provider, entry.modelId),
    name: entry.name,
    modelId: entry.modelId,
    provider,
    ...(entry.contextWindowSize ? { contextWindowSize: entry.contextWindowSize } : {}),
    ...(typeof entry.vision === "boolean" ? { vision: entry.vision } : {}),
  };
}

export function getCatalogCompletionModels(provider: ProviderOption): CompletionModel[] {
  return getCatalogEntries(provider)
    .filter((entry) => entry.role === "completion")
    .map((entry) => toCompletionModel(provider, entry));
}

export function getCatalogEmbeddingModels(provider: ProviderOption): EmbeddingModel[] {
  return getCatalogEntries(provider)
    .filter((entry) => entry.role === "embedding")
    .map((entry) => ({
      id: modelKey(provider, entry.modelId),
      name: entry.name,
      modelId: entry.modelId,
      provider,
    }));
}

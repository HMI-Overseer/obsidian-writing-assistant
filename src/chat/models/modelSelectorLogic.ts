import type { ProviderOption } from "../../shared/types";

/**
 * Pure logic behind the model dropdown's rail + search + favorites UI,
 * extracted from {@link ModelDropdownView} so it is unit-testable without DOM.
 *
 * Favorites are display markup over the composed selectable set, never a
 * second model source: every function here takes the already-composed model
 * list from `getSelectableCompletionModels()` / `getSelectableEmbeddingModels()`
 * and only filters / reorders it, so a disabled provider's models can never
 * leak in through a stale favorite key. Membership is checked against the
 * model's `id`, which is the composed `provider:modelId` key everywhere
 * (catalog, discovery cache, custom entries).
 */

/** The structural shape every selectable model (completion or embedding) shares. */
export interface SelectableModelLike {
  id: string;
  name: string;
  modelId: string;
  provider: ProviderOption;
}

/** The rail's categories: favorites on top, then one entry per provider. */
export type ModelSelectorCategory = "favorites" | ProviderOption;

export function isFavoriteModel(
  model: SelectableModelLike,
  favoriteKeys: readonly string[]
): boolean {
  return favoriteKeys.includes(model.id);
}

/**
 * Models for one rail category, in render order. Favorites is the selectable
 * set filtered by key membership; a provider category floats its starred
 * models to the top, keeping catalog order within each group.
 */
export function modelsForCategory<T extends SelectableModelLike>(
  models: readonly T[],
  category: ModelSelectorCategory,
  favoriteKeys: readonly string[]
): T[] {
  if (category === "favorites") {
    return models.filter((model) => isFavoriteModel(model, favoriteKeys));
  }
  const inProvider = models.filter((model) => model.provider === category);
  return [
    ...inProvider.filter((model) => isFavoriteModel(model, favoriteKeys)),
    ...inProvider.filter((model) => !isFavoriteModel(model, favoriteKeys)),
  ];
}

/** Case-insensitive substring filter over display name and model id. */
export function filterModelsByQuery<T extends SelectableModelLike>(
  models: readonly T[],
  query: string
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...models];
  return models.filter(
    (model) =>
      model.name.toLowerCase().includes(needle) ||
      model.modelId.toLowerCase().includes(needle)
  );
}

/**
 * Opening behavior: land on favorites if any favorite is currently
 * selectable, otherwise on the active model's provider, otherwise the first
 * enabled provider that contributes models (falling back to the first enabled
 * provider, then favorites, for the degenerate empty cases).
 */
export function resolveLandingCategory(
  models: readonly SelectableModelLike[],
  favoriteKeys: readonly string[],
  activeModel: SelectableModelLike | null,
  enabledProviders: readonly ProviderOption[]
): ModelSelectorCategory {
  if (models.some((model) => isFavoriteModel(model, favoriteKeys))) return "favorites";
  if (activeModel && enabledProviders.includes(activeModel.provider)) {
    return activeModel.provider;
  }
  const withModels = enabledProviders.find((provider) =>
    models.some((model) => model.provider === provider)
  );
  return withModels ?? enabledProviders[0] ?? "favorites";
}

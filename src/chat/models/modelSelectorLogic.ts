import type { CompletionModel, ProviderOption } from "../../shared/types";

/**
 * Pure logic behind the chat model selector's rail + search + favorites UI,
 * extracted from {@link ChatModelSelector} so it is unit-testable without DOM.
 *
 * Favorites are display markup over the composed selectable set, never a
 * second model source: every function here takes the already-composed model
 * list from `getSelectableCompletionModels()` and only filters / reorders it,
 * so a disabled provider's models can never leak in through a stale favorite
 * key. Membership is checked against `CompletionModel.id`, which is the
 * composed `provider:modelId` key everywhere (catalog, discovery cache,
 * custom entries).
 */

/** The rail's categories: favorites on top, then one entry per provider. */
export type ModelSelectorCategory = "favorites" | ProviderOption;

export function isFavoriteModel(
  model: CompletionModel,
  favoriteKeys: readonly string[]
): boolean {
  return favoriteKeys.includes(model.id);
}

/**
 * Models for one rail category, in render order. Favorites is the selectable
 * set filtered by key membership; a provider category floats its starred
 * models to the top, keeping catalog order within each group.
 */
export function modelsForCategory(
  models: readonly CompletionModel[],
  category: ModelSelectorCategory,
  favoriteKeys: readonly string[]
): CompletionModel[] {
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
export function filterModelsByQuery(
  models: readonly CompletionModel[],
  query: string
): CompletionModel[] {
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
  models: readonly CompletionModel[],
  favoriteKeys: readonly string[],
  activeModel: CompletionModel | null,
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

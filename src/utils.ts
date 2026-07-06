import type { CompletionModel, EmbeddingModel, PluginSettings } from "./shared/types";
import {
  getSelectableCompletionModels,
  getSelectableEmbeddingModels,
} from "./providers/selectableModels";

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/**
 * Exhaustiveness guard for closed unions: a `switch` that handles every arm
 * narrows its value to `never`, so an unhandled arm becomes a compile error
 * here rather than a silent fall-through at runtime.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled union member: ${JSON.stringify(value)}`);
}

function resolveModel<T extends { id: string }>(
  models: T[],
  id: string,
  aliases: Record<string, string>,
): T | null {
  const direct = models.find((model) => model.id === id);
  if (direct) return direct;
  const alias = aliases[id];
  if (alias) return models.find((model) => model.id === alias) ?? null;
  return null;
}

/**
 * Resolve a stored model reference (composed `provider:modelId` key, or a
 * pre-rework synthetic id via the alias map) against the composed selectable
 * list. A model whose provider is disabled resolves to null by design: the
 * disabled-provider state must never lie.
 */
export function resolveCompletionModel(
  settings: PluginSettings,
  completionModelId: string | null | undefined
): CompletionModel | null {
  if (!completionModelId) return null;
  return resolveModel(
    getSelectableCompletionModels(settings),
    completionModelId,
    settings.modelIdAliases,
  );
}

export function resolveEmbeddingModel(
  settings: PluginSettings,
  embeddingModelId: string | null | undefined
): EmbeddingModel | null {
  if (!embeddingModelId) return null;
  return resolveModel(
    getSelectableEmbeddingModels(settings),
    embeddingModelId,
    settings.modelIdAliases,
  );
}

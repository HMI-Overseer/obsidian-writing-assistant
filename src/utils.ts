import type { CompletionModel, PluginSettings } from "./shared/types";

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function resolveActiveCompletionModel(settings: PluginSettings): CompletionModel {
  return (
    settings.completionModels.find((model) => model.id === settings.activeCompletionModelId) ??
    settings.completionModels[0]
  );
}

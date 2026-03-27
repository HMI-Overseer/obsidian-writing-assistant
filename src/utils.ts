import type { CompletionModel, PluginSettings } from "./shared/types";

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function resolveCompletionModel(
  settings: PluginSettings,
  completionModelId: string | null | undefined
): CompletionModel | null {
  if (!completionModelId) return null;
  return settings.completionModels.find((model) => model.id === completionModelId) ?? null;
}

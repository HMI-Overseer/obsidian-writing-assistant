import type { CompletionModel, PluginSettings } from "./shared/types";

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

export function resolveCompletionModel(
  settings: PluginSettings,
  completionModelId: string | null | undefined
): CompletionModel | null {
  if (!completionModelId) return null;
  return settings.completionModels.find((model) => model.id === completionModelId) ?? null;
}

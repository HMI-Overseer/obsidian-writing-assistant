import type { ProviderOption } from "./types";

/**
 * Composed model identity: `provider:modelId`.
 *
 * This is the durable key used everywhere a model is referenced (conversation
 * metas, RAG / knowledge-graph selections). It matches what execution already
 * keys on, so the reference and the request can never disagree. Kept in
 * `shared/` (no obsidian, no provider imports) so both settings migration and
 * runtime code can use it.
 */

/** All provider keys in display order (local first, then cloud). */
export const PROVIDER_OPTIONS: readonly ProviderOption[] = [
  "lmstudio",
  "anthropic",
  "openai",
  "claudecode",
];

export function modelKey(provider: ProviderOption, modelId: string): string {
  return `${provider}:${modelId}`;
}

/**
 * Split a composed key back into its parts. Returns null for anything that is
 * not a composed key, including legacy synthetic ids (`model-1`) and legacy
 * discovery ids (`completion:<id>`), whose prefix is not a valid provider.
 */
export function parseModelKey(
  key: string,
): { provider: ProviderOption; modelId: string } | null {
  const separator = key.indexOf(":");
  if (separator <= 0) return null;
  const provider = key.slice(0, separator);
  if (!(PROVIDER_OPTIONS as readonly string[]).includes(provider)) return null;
  const modelId = key.slice(separator + 1);
  if (!modelId) return null;
  return { provider: provider as ProviderOption, modelId };
}

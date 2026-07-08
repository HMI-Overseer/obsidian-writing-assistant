import type { CompletionModel, ReasoningLevel } from "../shared/types";
import type { ReasoningCapability } from "../shared/reasoning";
import {
  anthropicModelSupportsAdaptiveThinking,
  anthropicModelSupportsXhighEffort,
} from "../api/buildAnthropicPayload";
import { PROVIDER_DESCRIPTORS } from "./descriptors";

/**
 * The discovery half of level resolution: per-model capability lookups that
 * only a live service can answer ({@link ../api/ModelAvailabilityService}
 * satisfies this). Kept as a minimal interface so the resolver, the UI, and
 * request-time validation stay constructible without the service in tests.
 */
export interface ReasoningDiscovery {
  getReasoningCapability(modelId: string): ReasoningCapability | undefined;
}

/**
 * Per-model reasoning-level resolution, the single source the composer pill,
 * the profile popover's reasoning control, and request-time validation all
 * read, so the offered set can never disagree between surfaces.
 *
 * Resolution is layered (composer-reasoning-effort-selector section 3.1), discovered
 * beats declared: a per-model discovered capability (LM Studio's
 * `capabilities.reasoning.allowed_options`) wins outright; the provider
 * descriptor's `reasoningLevels` is the fallback. LM Studio's fallback is
 * deliberately empty: reasoning support there is strictly per model, and
 * sending a level to a model without the capability can break the request
 * (the gemma4 jinja-template failure, 2026-07-06), so an undiscovered model
 * offers nothing rather than a guess. The Claude Code init-handshake harvest
 * (section 3.1 layer 2) slots in here the same way when it lands.
 */
export function resolveReasoningLevels(
  model: CompletionModel,
  discovery?: ReasoningDiscovery,
): ReasoningLevel[] {
  const discovered = discovery?.getReasoningCapability(model.modelId);
  if (discovered) return discovered.allowedOptions;
  if (model.provider === "anthropic") return anthropicCatalogLevels(model.modelId);
  return PROVIDER_DESCRIPTORS[model.provider].reasoningLevels;
}

/**
 * The catalog layer for Anthropic (section 3.1 layer 2 equivalent, keyed off the same
 * capability gates the payload builder enforces, so the offered set and the
 * emitted request can never disagree): adaptive-capable models take effort
 * tiers up to `max`, with `xhigh` only where the API honors it (Opus 4.7+;
 * 4.6-family silently downgrades it, so it is not offered). Non-adaptive /
 * unknown ids keep the descriptor fallback, the payload emits no thinking for
 * them anyway, so the levels are inert legacy semantics.
 */
function anthropicCatalogLevels(modelId: string): ReasoningLevel[] {
  if (!anthropicModelSupportsAdaptiveThinking(modelId)) {
    return PROVIDER_DESCRIPTORS.anthropic.reasoningLevels;
  }
  return anthropicModelSupportsXhighEffort(modelId)
    ? ["off", "low", "medium", "high", "xhigh", "max"]
    : ["off", "low", "medium", "high", "max"];
}

/** Whether the model offers any reasoning control at all (empty set = no UI). */
export function supportsReasoning(model: CompletionModel, discovery?: ReasoningDiscovery): boolean {
  return resolveReasoningLevels(model, discovery).length > 0;
}

/**
 * The reasoning level to send for a model: its stored per-model entry, clamped
 * against the currently resolved set. A stored level outside the set (a profile
 * repointed at a model with a different vocabulary, a retired tier, a model
 * that reports no reasoning capability at all) resolves to null, i.e. the
 * model's own default, and is never rewritten on disk. For LM Studio the clamp
 * is a correctness guard, not just display honesty: the native API errors on an
 * unsupported reasoning setting, and some models' chat templates fail to render
 * when the compat endpoint carries one.
 */
export function resolveModelReasoning(
  reasoningByModelKey: Record<string, ReasoningLevel>,
  model: CompletionModel,
  discovery?: ReasoningDiscovery,
): ReasoningLevel | null {
  const stored = reasoningByModelKey[model.id];
  if (!stored) return null;
  return resolveReasoningLevels(model, discovery).includes(stored) ? stored : null;
}

import type { ProviderProfile, ReasoningLevel, SamplingParams } from "../../shared/types";

/**
 * Assembles the sampling params for a turn. `reasoning` is no longer a profile
 * field: it is remembered per model (`reasoningByModelKey`) and resolved +
 * clamped by {@link ../../providers/reasoningLevels.resolveModelReasoning}
 * before it reaches here, so callers pass the already-resolved level.
 */
export function buildSamplingParams(
  profile: ProviderProfile,
  reasoning: ReasoningLevel | null,
): SamplingParams {
  return {
    temperature: profile.temperature,
    maxTokens: profile.maxTokens,
    topP: profile.topP,
    topK: profile.topK,
    minP: profile.minP,
    repeatPenalty: profile.repeatPenalty,
    reasoning,
  };
}

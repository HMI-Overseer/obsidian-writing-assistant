import type { ProviderProfile, SamplingParams } from "../../shared/types";

export function buildSamplingParams(profile: ProviderProfile): SamplingParams {
  return {
    temperature: profile.temperature,
    maxTokens: profile.maxTokens,
    topP: profile.topP,
    topK: profile.topK,
    minP: profile.minP,
    repeatPenalty: profile.repeatPenalty,
    reasoning: profile.reasoning,
  };
}

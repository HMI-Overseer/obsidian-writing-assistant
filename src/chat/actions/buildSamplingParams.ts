import type { PluginSettings, SamplingParams } from "../../shared/types";

export function buildSamplingParams(settings: PluginSettings): SamplingParams {
  return {
    temperature: settings.globalTemperature,
    maxTokens: settings.globalMaxTokens,
    topP: settings.globalTopP,
    topK: settings.globalTopK,
    minP: settings.globalMinP,
    repeatPenalty: settings.globalRepeatPenalty,
    reasoning: settings.globalReasoning,
  };
}

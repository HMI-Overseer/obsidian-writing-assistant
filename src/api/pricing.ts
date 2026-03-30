import type { UsageResult } from "./usageTypes";

interface ModelPricing {
  inputPerMillionTokens: number;
  outputPerMillionTokens: number;
  cacheCreationPerMillionTokens?: number;
  cacheReadPerMillionTokens?: number;
}

/**
 * Hardcoded Anthropic pricing (USD per million tokens).
 * Keys are model ID prefixes — the longest matching prefix wins.
 * Updated: 2025-05. Source: https://docs.anthropic.com/en/docs/about-claude/models
 */
const ANTHROPIC_PRICING: [prefix: string, pricing: ModelPricing][] = [
  ["claude-opus-4", { inputPerMillionTokens: 15, outputPerMillionTokens: 75, cacheCreationPerMillionTokens: 18.75, cacheReadPerMillionTokens: 1.50 }],
  ["claude-sonnet-4", { inputPerMillionTokens: 3, outputPerMillionTokens: 15, cacheCreationPerMillionTokens: 3.75, cacheReadPerMillionTokens: 0.30 }],
  ["claude-3-5-sonnet", { inputPerMillionTokens: 3, outputPerMillionTokens: 15, cacheCreationPerMillionTokens: 3.75, cacheReadPerMillionTokens: 0.30 }],
  ["claude-3-5-haiku", { inputPerMillionTokens: 0.80, outputPerMillionTokens: 4, cacheCreationPerMillionTokens: 1, cacheReadPerMillionTokens: 0.08 }],
  ["claude-3-opus", { inputPerMillionTokens: 15, outputPerMillionTokens: 75, cacheCreationPerMillionTokens: 18.75, cacheReadPerMillionTokens: 1.50 }],
  ["claude-3-haiku", { inputPerMillionTokens: 0.25, outputPerMillionTokens: 1.25, cacheCreationPerMillionTokens: 0.30, cacheReadPerMillionTokens: 0.03 }],
];

function lookupPricing(modelId: string): ModelPricing | null {
  let bestMatch: ModelPricing | null = null;
  let bestLength = 0;

  for (const [prefix, pricing] of ANTHROPIC_PRICING) {
    if (modelId.startsWith(prefix) && prefix.length > bestLength) {
      bestMatch = pricing;
      bestLength = prefix.length;
    }
  }

  return bestMatch;
}

/**
 * Estimate the cost in USD for a completion request.
 * Returns null if the model is unknown (e.g., LM Studio / free models).
 */
export function estimateCost(modelId: string, usage: UsageResult): number | null {
  const pricing = lookupPricing(modelId);
  if (!pricing) return null;

  let cost = 0;
  cost += (usage.inputTokens / 1_000_000) * pricing.inputPerMillionTokens;
  cost += (usage.outputTokens / 1_000_000) * pricing.outputPerMillionTokens;

  if (usage.cacheCreationInputTokens && pricing.cacheCreationPerMillionTokens) {
    cost += (usage.cacheCreationInputTokens / 1_000_000) * pricing.cacheCreationPerMillionTokens;
  }
  if (usage.cacheReadInputTokens && pricing.cacheReadPerMillionTokens) {
    cost += (usage.cacheReadInputTokens / 1_000_000) * pricing.cacheReadPerMillionTokens;
  }

  return cost;
}

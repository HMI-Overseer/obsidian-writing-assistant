import type { UsageResult } from "./usageTypes";
import pricingData from "./pricingData.json";

interface ModelPricing {
  inputPerMillionTokens: number;
  outputPerMillionTokens: number;
  cacheCreationPerMillionTokens?: number;
  cacheReadPerMillionTokens?: number;
}

/**
 * Date the live-feed prices below were last refreshed from the upstream source.
 * Generated into pricingData.json by scripts/update-pricing.mjs (run on every
 * `npm version`), and surfaced in the UI (see {@link UsageBadge}) so a stale
 * estimate reads as an estimate "as of" a date, not as authority. Build-time
 * refresh / no-runtime-fetch rationale: ADR-0007.
 */
export const PRICING_AS_OF = pricingData.asOf;

interface FeedPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}
const FEED = pricingData.models as Record<string, FeedPrice>;

/** Map a generated per-MTok feed entry onto the internal {@link ModelPricing} shape. */
function fromFeed(modelId: string): ModelPricing {
  const p = FEED[modelId];
  return {
    inputPerMillionTokens: p.input,
    outputPerMillionTokens: p.output,
    cacheCreationPerMillionTokens: p.cacheWrite,
    cacheReadPerMillionTokens: p.cacheRead,
  };
}

// Frozen tiers for models NOT on the refreshed feed: retired / deprecated rates
// (which never change) and the Glasswing-only Mythos. Cache figures follow
// Anthropic's published multipliers: cache write (5-min TTL) = 1.25x input,
// cache read = 0.1x input.
const OPUS_4_5: ModelPricing = { inputPerMillionTokens: 5, outputPerMillionTokens: 25, cacheCreationPerMillionTokens: 6.25, cacheReadPerMillionTokens: 0.50 };
const OPUS_LEGACY: ModelPricing = { inputPerMillionTokens: 15, outputPerMillionTokens: 75, cacheCreationPerMillionTokens: 18.75, cacheReadPerMillionTokens: 1.50 };
const SONNET_4: ModelPricing = { inputPerMillionTokens: 3, outputPerMillionTokens: 15, cacheCreationPerMillionTokens: 3.75, cacheReadPerMillionTokens: 0.30 };

/**
 * Anthropic pricing (USD per million tokens). Keys are model ID prefixes; the
 * longest matching prefix wins. The current frontier is sourced from
 * pricingData.json (refreshed at release time); the retired/Glasswing tail is
 * hardcoded below because those rates are frozen.
 *
 * The Opus 4 family is listed per-version on purpose: its price is NOT uniform
 * (4.0/4.1 = $15/$75, 4.5+ = $5/$25), so there is deliberately no broad
 * "claude-opus-4" catch-all. A future Opus neither in the feed nor listed here
 * falls to `null` (honestly unknown) rather than inheriting a neighbour's rate.
 */
const ANTHROPIC_PRICING: [prefix: string, pricing: ModelPricing][] = [
  // Current frontier, refreshed from pricingData.json each release.
  ["claude-opus-4-8", fromFeed("claude-opus-4-8")],
  ["claude-opus-4-7", fromFeed("claude-opus-4-7")],
  ["claude-opus-4-6", fromFeed("claude-opus-4-6")],
  ["claude-sonnet-4-6", fromFeed("claude-sonnet-4-6")],
  ["claude-haiku-4-5", fromFeed("claude-haiku-4-5")],
  ["claude-fable-5", fromFeed("claude-fable-5")],
  // Mythos 5 (Project Glasswing only; absent from the public feed) mirrors Fable 5.
  ["claude-mythos-5", fromFeed("claude-fable-5")],
  // Opus 4.5, active but stable, kept off the refreshed set.
  ["claude-opus-4-5", OPUS_4_5],
  // Legacy Opus 4.0 / 4.1, $15/$75, before the 4.5 price drop. Longest-prefix
  // match means the 4.5+ rows above win; the dated 4.0 ID has no shared prefix
  // with its alias, so it is listed explicitly.
  ["claude-opus-4-1", OPUS_LEGACY],
  ["claude-opus-4-0", OPUS_LEGACY],
  ["claude-opus-4-20250514", OPUS_LEGACY],
  // Sonnet 4 family base (4.0 / 4.5) is uniformly $3/$15; a single base prefix is
  // safe here where it is not for Opus. (4.6 is on the feed above.)
  ["claude-sonnet-4", SONNET_4],
  // Claude 3.x (retired; frozen rates).
  ["claude-3-5-sonnet", SONNET_4],
  ["claude-3-5-haiku", { inputPerMillionTokens: 0.80, outputPerMillionTokens: 4, cacheCreationPerMillionTokens: 1, cacheReadPerMillionTokens: 0.08 }],
  ["claude-3-opus", OPUS_LEGACY],
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

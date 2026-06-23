import type { MessageUsage, ProviderOption } from "../../shared/types";
import { PROVIDER_DESCRIPTORS } from "../../providers/descriptors";
import { PRICING_AS_OF } from "../../api/pricing";

/**
 * Whether the provider bills per token (Anthropic, OpenAI, Claude Code) versus a
 * free/local model (LM Studio). Used to tell "metered model with no price table
 * entry" apart from "free local model" — the former surfaces "price unavailable",
 * the latter shows nothing.
 */
function isMeteredProvider(provider: ProviderOption | undefined): boolean {
  return provider !== undefined && PROVIDER_DESCRIPTORS[provider].billingModel === "per-token";
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function renderUsageBadge(
  parentEl: HTMLElement,
  usage: MessageUsage | undefined,
  modelId: string | undefined,
  provider: ProviderOption | undefined
): HTMLElement | null {
  // Nothing to show for messages without usage or model info.
  if (!usage && !modelId) return null;

  const badgeEl = parentEl.createDiv({ cls: "lmsa-chat-window-usage-badge" });

  if (usage) {
    badgeEl.createSpan({
      cls: "lmsa-chat-window-usage-tokens",
      text: `${formatTokenCount(usage.inputTokens)} in \u00b7 ${formatTokenCount(usage.outputTokens)} out`,
    });

    // Prompt-cache figures, shown only for cache-capable providers (Anthropic,
    // Claude Code report these fields). A "0 cache read" is itself the signal
    // that a turn missed the cache and reprocessed its prefix from scratch.
    if (usage.cacheReadInputTokens !== undefined) {
      const writeSuffix =
        usage.cacheCreationInputTokens && usage.cacheCreationInputTokens > 0
          ? ` · ${formatTokenCount(usage.cacheCreationInputTokens)} cache write`
          : "";
      badgeEl.createSpan({
        cls: "lmsa-chat-window-usage-cache",
        text: `${formatTokenCount(usage.cacheReadInputTokens)} cache read${writeSuffix}`,
      });
    }

    // Claude Code runs on a subscription, so per-message cost is meaningless,
    // show the plan instead of a calculated price.
    if (provider === "claudecode") {
      badgeEl.createSpan({
        cls: "lmsa-chat-window-usage-cost",
        text: "Subscription",
      });
    } else if (
      usage.estimatedCostUsd !== null &&
      usage.estimatedCostUsd !== undefined &&
      usage.estimatedCostUsd > 0
    ) {
      // A token-table estimate, not a billed figure. The "~" and the dated tooltip
      // keep it honestly an estimate "as of" a price snapshot, not authoritative.
      badgeEl.createSpan({
        cls: "lmsa-chat-window-usage-cost",
        text: `~${formatCost(usage.estimatedCostUsd)}`,
        title: `Estimated from pricing as of ${PRICING_AS_OF}`,
      });
    } else if (usage.estimatedCostUsd === undefined && isMeteredProvider(provider)) {
      // A per-token provider whose model isn't in the price table. Surfacing this
      // as "price unavailable" distinguishes it from a free/local model, which
      // intentionally shows no cost at all.
      badgeEl.createSpan({
        cls: "lmsa-chat-window-usage-cost-unavailable",
        text: "price unavailable",
        title: "No local pricing data for this model",
      });
    }
  }

  // Show model tag in mixed-provider conversations for clarity.
  if (modelId && provider && provider !== "lmstudio") {
    badgeEl.createSpan({
      cls: "lmsa-chat-window-usage-model",
      text: modelId,
    });
  }

  return badgeEl;
}

import type { MessageUsage, ProviderOption } from "../../shared/types";

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
      badgeEl.createSpan({
        cls: "lmsa-chat-window-usage-cost",
        text: formatCost(usage.estimatedCostUsd),
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

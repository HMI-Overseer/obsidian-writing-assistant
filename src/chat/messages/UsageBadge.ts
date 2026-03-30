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

  const badgeEl = parentEl.createDiv({ cls: "lmsa-usage-badge" });

  if (usage) {
    badgeEl.createSpan({
      cls: "lmsa-usage-tokens",
      text: `${formatTokenCount(usage.inputTokens)} in \u00b7 ${formatTokenCount(usage.outputTokens)} out`,
    });

    if (usage.estimatedCostUsd !== null && usage.estimatedCostUsd !== undefined && usage.estimatedCostUsd > 0) {
      badgeEl.createSpan({
        cls: "lmsa-usage-cost",
        text: formatCost(usage.estimatedCostUsd),
      });
    }
  }

  // Show model tag in mixed-provider conversations for clarity.
  if (modelId && provider && provider !== "lmstudio") {
    badgeEl.createSpan({
      cls: "lmsa-usage-model",
      text: modelId,
    });
  }

  return badgeEl;
}

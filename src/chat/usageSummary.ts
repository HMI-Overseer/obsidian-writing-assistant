import type { ConversationMessage, MessageUsage } from "../shared/types";

export interface UsageTotals {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  hasUsage: boolean;
}

function addUsage(totals: UsageTotals, usage: MessageUsage): void {
  totals.hasUsage = true;
  totals.totalInputTokens += usage.inputTokens;
  totals.totalOutputTokens += usage.outputTokens;
  if (usage.estimatedCostUsd) {
    totals.totalCost += usage.estimatedCostUsd;
  }
}

/**
 * Sum token counts and costs across all messages in a conversation.
 * For messages with versions (regenerated), sums ALL version costs
 * since each regeneration is a real API call.
 */
export function sumConversationUsage(messages: ConversationMessage[]): UsageTotals {
  const totals: UsageTotals = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    hasUsage: false,
  };

  for (const msg of messages) {
    if (msg.versions) {
      for (const version of msg.versions) {
        if (version.usage) {
          addUsage(totals, version.usage);
        }
      }
    } else if (msg.usage) {
      addUsage(totals, msg.usage);
    }
  }

  return totals;
}

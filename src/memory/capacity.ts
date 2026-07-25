/**
 * The memory index's advisory capacity readout (RFC-0007). The index is always-on
 * prompt text, so its cost is a standing tax the user should be able to see; the
 * budget is a UX heuristic that makes it visible, not a model-capability claim.
 * Nothing evicts, ranks, or blocks past it: the user curates.
 *
 * Occupancy reuses the composer context ring's thresholds and its `is-warning` /
 * `is-danger` vocabulary so both readouts change color at the same fullness.
 * Pure: no Obsidian, no DOM.
 */

import { CONTEXT_DANGER_THRESHOLD, CONTEXT_WARNING_THRESHOLD } from "../constants";
import { formatTokens } from "../shared/tokenEstimation";

/**
 * The initial soft budget for the rendered index, in estimated tokens.
 * Explicitly experimental: RFC-0007 commits to revisiting it with evaluation data.
 */
export const MEMORY_INDEX_TOKEN_BUDGET = 3000;

export type MemoryCapacityState = "normal" | "warning" | "danger";

export interface MemoryCapacity {
  /** Estimated tokens in the current rendered index. */
  tokens: number;
  budget: number;
  /** Unclamped occupancy, so an over-budget index reports past 1. */
  ratio: number;
  /** Honest percentage, which may exceed 100. */
  percent: number;
  /** Bar width percentage, clamped to 100. */
  barPercent: number;
  state: MemoryCapacityState;
  /** The readout beside the bar, e.g. "~1.2k of 3.0k tokens (40%)". */
  label: string;
}

export function computeMemoryCapacity(
  tokens: number,
  budget: number = MEMORY_INDEX_TOKEN_BUDGET,
): MemoryCapacity {
  const safeBudget = budget > 0 ? budget : MEMORY_INDEX_TOKEN_BUDGET;
  const ratio = tokens / safeBudget;
  const percent = Math.round(ratio * 100);

  let state: MemoryCapacityState = "normal";
  if (ratio >= CONTEXT_DANGER_THRESHOLD) {
    state = "danger";
  } else if (ratio >= CONTEXT_WARNING_THRESHOLD) {
    state = "warning";
  }

  return {
    tokens,
    budget: safeBudget,
    ratio,
    percent,
    barPercent: Math.min(percent, 100),
    state,
    label: `~${formatTokens(tokens)} of ${formatTokens(safeBudget)} tokens (${percent}%)`,
  };
}

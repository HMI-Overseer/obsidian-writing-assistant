import type { AssistantTurnRecord } from "../../shared/types";
import { findPartialBlock } from "../../editing/parseEditBlocks";
import type { AssistantTurnSnapshot } from "../turns/AssistantTurnBuilder";
import { rawConcatenatedProse } from "../turns/assistantTurnProjections";

export interface RegexEditPreview {
  completeBlockCount: number;
  hasIncompleteBlock: boolean;
}

/**
 * Small non-tool fallback projection over canonical turn prose.
 *
 * It owns no streamed bytes and creates no assistant item. Final proposal
 * parsing still runs from the frozen turn.
 */
export function projectRegexEditPreview(
  turn: AssistantTurnRecord | AssistantTurnSnapshot,
): RegexEditPreview | null {
  const prose = rawConcatenatedProse(turn);
  if (!prose.includes("<<<<<<< SEARCH")) return null;
  const partial = findPartialBlock(prose);
  return {
    completeBlockCount: partial.completeBlocks.length,
    hasIncompleteBlock: partial.hasIncompleteBlock,
  };
}

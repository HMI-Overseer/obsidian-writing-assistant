import { generateId } from "../utils";
import type { EditBlock } from "./editTypes";

/**
 * Regex matching complete <<<SEARCH ... === ... REPLACE>>> blocks.
 * Uses non-greedy quantifiers so adjacent blocks are matched individually.
 */
const BLOCK_REGEX = /<<<SEARCH\n([\s\S]*?)\n===\n([\s\S]*?)\nREPLACE>>>/g;

/**
 * Detects an incomplete block that has started but not yet closed.
 * Matches an opening <<<SEARCH that is not followed by a closing REPLACE>>>.
 */
const PARTIAL_OPEN_REGEX = /<<<SEARCH\n(?![\s\S]*?\nREPLACE>>>)/;

export interface ParseResult {
  /** Fully parsed edit blocks. */
  blocks: EditBlock[];
  /** Text content with all blocks removed (the model's explanatory prose). */
  prose: string;
}

export interface PartialParseResult {
  /** Blocks that have been fully completed so far. */
  completeBlocks: EditBlock[];
  /** Whether the text ends with an incomplete block still being written. */
  hasIncompleteBlock: boolean;
}

/**
 * Parse all complete <<<SEARCH...REPLACE>>> blocks from the model's full response.
 * Returns the extracted blocks and the remaining prose with blocks stripped out.
 */
export function parseEditBlocks(text: string): ParseResult {
  const blocks: EditBlock[] = [];
  const proseSegments: string[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(BLOCK_REGEX)) {
    const matchStart = match.index ?? 0;
    if (matchStart > lastIndex) {
      proseSegments.push(text.slice(lastIndex, matchStart));
    }
    lastIndex = matchStart + match[0].length;

    blocks.push({
      id: generateId(),
      searchText: match[1],
      replaceText: match[2],
      rawBlock: match[0],
    });
  }

  if (lastIndex < text.length) {
    proseSegments.push(text.slice(lastIndex));
  }

  const prose = proseSegments.join("").replace(/\n{3,}/g, "\n\n").trim();

  return { blocks, prose };
}

/**
 * Streaming-friendly parser. Identifies complete blocks parsed so far
 * and whether an incomplete block is currently being written.
 * Used by EditStreamingRenderer to show progress indicators.
 */
export function findPartialBlock(text: string): PartialParseResult {
  const completeBlocks: EditBlock[] = [];

  for (const match of text.matchAll(BLOCK_REGEX)) {
    completeBlocks.push({
      id: generateId(),
      searchText: match[1],
      replaceText: match[2],
      rawBlock: match[0],
    });
  }

  // Strip all complete blocks, then check if a partial <<<SEARCH remains
  let remaining = text;
  for (const block of completeBlocks) {
    remaining = remaining.replace(block.rawBlock, "");
  }

  const hasIncompleteBlock = PARTIAL_OPEN_REGEX.test(remaining);

  return { completeBlocks, hasIncompleteBlock };
}

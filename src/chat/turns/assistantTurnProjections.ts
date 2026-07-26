import type {
  AssistantToolCallItem,
  AssistantTurnRecord,
} from "../../shared/types";

export const INTERRUPTED_TOOL_RESULT_TEXT =
  "Tool execution was interrupted before a result was produced.";

export interface InterruptedAssistantToolResult {
  toolCallId: string;
  content: typeof INTERRUPTED_TOOL_RESULT_TEXT;
  isError: true;
}

/** Every visible prose item in declaration order, separated for display. */
export function allVisibleProse(turn: AssistantTurnRecord): string {
  return turn.items
    .filter((item) => item.type === "prose")
    .map((item) => item.text)
    .join("\n\n");
}

/** Exact prose bytes in declaration order, with no display separator added. */
export function rawConcatenatedProse(turn: AssistantTurnRecord): string {
  return turn.items
    .filter((item) => item.type === "prose")
    .map((item) => item.text)
    .join("");
}

/** Exact bytes of the last prose item containing a non-whitespace character. */
export function lastNonEmptyProse(
  turn: AssistantTurnRecord,
): string | null {
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (item.type === "prose" && item.text.trim().length > 0) {
      return item.text;
    }
  }
  return null;
}

/**
 * Bounded textual evidence for one declared tool.
 *
 * Structural replay does not use this projection. A caller may use it only
 * after explicitly selecting the textual fallback tier.
 */
export function toolFactText(item: AssistantToolCallItem): string {
  if (item.resultDigest?.trim()) return item.resultDigest;

  const label = item.toolInput?.trim()
    ? `${item.toolName}: ${item.toolInput}`
    : item.toolName;
  if (item.state === "interrupted") {
    return `[${label}, INTERRUPTED: ${INTERRUPTED_TOOL_RESULT_TEXT}]`;
  }
  if (item.state === "failed" || item.isError === true) {
    const detail =
      item.errorContent?.trim() ||
      item.resultRecord?.trim() ||
      "Tool execution failed.";
    return `[${label}, FAILED: ${detail}]`;
  }
  return `[${label}, ${item.state}]`;
}

/** Deterministic error result paired to one interrupted declaration. */
export function deriveInterruptedToolResult(
  item: AssistantToolCallItem,
): InterruptedAssistantToolResult {
  if (item.state !== "interrupted") {
    throw new Error(`Tool item "${item.id}" is not interrupted.`);
  }
  return {
    toolCallId: item.toolCallId,
    content: INTERRUPTED_TOOL_RESULT_TEXT,
    isError: true,
  };
}

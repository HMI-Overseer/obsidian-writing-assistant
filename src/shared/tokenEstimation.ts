import type { ChatRequest } from "./chatRequest";

/**
 * Approximate character-to-token ratio for English text.
 * ~4 characters per token is a well-established heuristic across most tokenizers.
 * This is intentionally rough, used for capacity indicators, not billing.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Estimate the token count of a ChatRequest before sending it to the API.
 *
 * Uses a `chars / 4` heuristic. The estimate is within ~15-25% of actual
 * tokenizer output for typical English prose, which is acceptable for a
 * context capacity indicator. After each Anthropic API call, the real
 * token count from the response can replace this estimate.
 *
 * Operates on the provider-independent `ChatRequest`, so it estimates
 * exactly the same content that will be serialized and sent.
 */
export function estimateTokenCount(request: ChatRequest, draft?: string): number {
  let totalChars = 0;

  if (request.systemPrompt) {
    totalChars += request.systemPrompt.length;
  }

  // The per-mode tail (mode framing + tool guidance) is sent each turn, just in a
  // different place than systemPrompt, so count it for an accurate estimate.
  if (request.modeTail) {
    totalChars += request.modeTail.length;
  }

  if (request.documentContext) {
    // Account for the label prefix that clients prepend (e.g. "---\nCurrent note (path):\n")
    totalChars += request.documentContext.filePath.length + 30;
    totalChars += request.documentContext.content.length;
  }

  if (request.ragContext) {
    for (const block of request.ragContext) {
      totalChars += block.filePath.length + block.headingPath.length + block.content.length + 40;
    }
  }

  for (const turn of request.messages) {
    totalChars += (turn.content ?? "").length;
    // Note snapshots live in the conversation now, count their text. Image
    // attachments are excluded (their token cost is tile-based, not char-based).
    for (const attachment of turn.attachments ?? []) {
      if (attachment.type === "note") {
        totalChars += attachment.filePath.length + attachment.content.length + 30;
      }
    }
  }

  if (draft) {
    totalChars += draft.length;
  }

  return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

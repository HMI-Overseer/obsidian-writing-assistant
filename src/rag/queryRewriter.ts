import type { ChatClient } from "../api/chatClient";
import type { ChatRequest, ChatTurn } from "../shared/chatRequest";
import type { SamplingParams } from "../shared/types";

/**
 * Maximum number of preceding USER turns to include as context.
 * Only user messages are passed — assistant responses are verbose and
 * risk leaking topic words into the rewrite (e.g. "lessons" appearing
 * in an assistant reply about Will's lessons contaminates a follow-up
 * query about his reactive dialogue).
 */
const HISTORY_WINDOW = 3;

const REWRITE_SYSTEM_PROMPT = `Rewrite the follow-up message as a standalone search query for semantic similarity search.

Rules:
- Output ONLY the rewritten query — no explanation, no preamble, no quotes
- Use the follow-up's topic only — do NOT carry over topics from prior messages
- Resolve pronouns (he/she/his/her/it/they/that/this) to the specific entity from context
- Keep the query concise — a short phrase or one sentence

Examples:
Context: "What are the lessons of will"
Follow-up: "what about his reactive dialogue"
Query: Will's reactive dialogue

Context: "Tell me about Strife"
Follow-up: "How does she interact with War?"
Query: Strife's interactions with War

Context: "Describe the Iron Castle"
Follow-up: "Who built it?"
Query: who built the Iron Castle`;

const REWRITE_PARAMS: SamplingParams = {
  temperature: 0,
  maxTokens: 150,
  topP: null,
  topK: null,
  minP: null,
  repeatPenalty: null,
  reasoning: null,
};

/**
 * Rewrites the current user query into a standalone search query using
 * recent conversation history for disambiguation (pronoun resolution,
 * implicit topic carryover). Returns the original query unchanged when
 * there is no history to disambiguate against, or on any error.
 */
export async function rewriteQueryForRetrieval(
  currentQuery: string,
  conversationMessages: ChatTurn[],
  chatClient: ChatClient,
  modelId: string,
  signal?: AbortSignal,
): Promise<string> {
  // Only user messages — assistant responses are verbose and risk leaking
  // topic words into the rewrite (e.g. an answer about "lessons" contaminating
  // a follow-up query about a different topic).
  const userTurns = conversationMessages.filter(
    (m): m is ChatTurn & { content: string } =>
      m.role === "user" && typeof m.content === "string",
  );

  // First turn — nothing to disambiguate against.
  if (userTurns.length < 2) return currentQuery;

  // Sliding window: the prior user messages (excluding the current one).
  const historyTurns = userTurns.slice(-1 - HISTORY_WINDOW, -1);
  if (historyTurns.length === 0) return currentQuery;

  const formattedContext = historyTurns.map((t) => t.content).join("\n");

  const userMessage = `Context: "${formattedContext}"\nFollow-up: "${currentQuery}"\nQuery:`;

  const request: ChatRequest = {
    systemPrompt: REWRITE_SYSTEM_PROMPT,
    documentContext: null,
    ragContext: null,
    messages: [{ role: "user", content: userMessage }],
  };

  try {
    const result = await chatClient.complete(request, modelId, REWRITE_PARAMS, signal);
    const rewritten = result.text.trim();
    return rewritten || currentQuery;
  } catch {
    return currentQuery;
  }
}

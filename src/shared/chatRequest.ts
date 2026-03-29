/** Document context attached to the request. */
export interface DocumentContext {
  /** File path within the vault. */
  filePath: string;
  /** The note content (may be truncated in chat mode). */
  content: string;
  /** true = full document (edit mode), false = truncated excerpt (chat context). */
  isFull: boolean;
}

/**
 * A conversation turn in the chat history.
 * Excludes "system" — system instructions are top-level in ChatRequest.
 */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Provider-independent chat completion request.
 * Produced by the chat domain, consumed by provider-specific clients.
 */
export interface ChatRequest {
  /** Behavioral instructions (system prompt). Empty string = no system prompt. */
  systemPrompt: string;
  /** Optional document context (active note). null = no document attached. */
  documentContext: DocumentContext | null;
  /** Conversation turns in chronological order. */
  messages: ChatTurn[];
}

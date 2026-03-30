/** Token usage returned by a provider after a completion request. */
export interface UsageResult {
  inputTokens: number;
  outputTokens: number;
  /** Tokens written to cache (Anthropic only). */
  cacheCreationInputTokens?: number;
  /** Tokens read from cache (Anthropic only). */
  cacheReadInputTokens?: number;
}

/** Wrapper returned by ChatClient.stream(). */
export interface StreamResult {
  /** Async generator yielding text deltas. */
  deltas: AsyncGenerator<string>;
  /** Resolves when the stream ends. null if the provider does not report usage. */
  usage: Promise<UsageResult | null>;
}

/** Wrapper returned by ChatClient.complete(). */
export interface CompletionResult {
  text: string;
  usage: UsageResult | null;
}

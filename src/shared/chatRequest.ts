import type { AnthropicCacheSettings } from "./types";
import type { CanonicalToolDefinition } from "../tools/types";

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
  role: "user" | "assistant" | "tool";
  /** Message content. null for assistant-only-tool-calls turns (OpenAI spec). */
  content: string | null;
  /** For tool result turns: the ID of the tool call this responds to. */
  toolCallId?: string;
  /** For assistant turns that contain tool calls: the tool calls made. */
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
}

/** Graph entities and relationships relevant to a retrieved document. */
export interface GraphContextAnnotation {
  entities: { name: string; type: string; description: string }[];
  relationships: { source: string; target: string; type: string; description: string }[];
}

/** A block of RAG-retrieved context injected into the request. */
export interface RagContextBlock {
  filePath: string;
  headingPath: string;
  content: string;
  score: number;
  graphContext?: GraphContextAnnotation;
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
  /** RAG retrieval results. null = RAG disabled or no results. */
  ragContext: RagContextBlock[] | null;
  /** Rewritten retrieval query, set when query rewriting changed the original user message. */
  rewrittenQuery?: string;
  /** Conversation turns in chronological order. */
  messages: ChatTurn[];
  /** Anthropic prompt caching settings. Attached when the active model has caching enabled. */
  anthropicCacheSettings?: AnthropicCacheSettings;
  /** Tool definitions to include in the request. null/undefined = no tools. */
  tools?: CanonicalToolDefinition[] | null;
}

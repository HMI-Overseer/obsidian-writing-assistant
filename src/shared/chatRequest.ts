import type { AnthropicCacheSettings, Attachment, ImageMimeType } from "./types";
import type { CanonicalToolDefinition } from "../tools/types";

/** A context item manually attached by the user via the context picker or drag-and-drop. */
export interface ExtraContextItem {
  filePath: string;
  fileName: string;
  /**
   * Inline content captured at attach time for files that live outside the vault
   * (dragged in from the OS file system). When present, the send-time snapshot uses
   * this text directly instead of resolving `filePath` against the vault. Absent for
   * vault notes, which are re-read from disk at send so their snapshot stays fresh.
   */
  content?: string;
}

/** A resolved extra context item ready to be sent to the provider. */
export interface AdditionalContextItem {
  filePath: string;
  fileName: string;
  content: string;
}

/**
 * Layer-2 tool-search configuration (ADR-0009 / prompt-cache design §6.2). Present only on
 * the direct `anthropic` agentic path when caching is on: it tells the Anthropic formatter
 * to prepend the native tool-search entry and mark every emitted tool whose name is not in
 * `nonDeferredToolNames` with `defer_loading`, so the long tail loads on demand and stays
 * out of the cached prefix. Absent everywhere else, so the Layer-1 emission is unchanged.
 */
export interface ToolSearchConfig {
  /** The native tool-search variant. Regex today (the one swappable wire entry). */
  variant: "regex";
  /** Tool names kept non-deferred (the core reads + `think`); everything else defers. */
  nonDeferredToolNames: string[];
}

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
 * Excludes "system", system instructions are top-level in ChatRequest.
 */
export interface ChatTurn {
  role: "user" | "assistant" | "tool";
  /** Message content. null for assistant-only-tool-calls turns (OpenAI spec). */
  content: string | null;
  /**
   * The persisted, annotation-free content, set only when `content` was rewritten
   * for presentation (edit-outcome annotations on tool-call edit turns) AND the model
   * already received that information in-band (each write's disposition rides its
   * tool result). The Claude Code live session hashed the raw streamed text, so its
   * linearity check reads this instead of `content`, keeping reuse alive across
   * edit turns. Absent everywhere the rewrite carries new information (regex-parsed
   * edits), where invalidating the session is how the model learns the outcomes.
   * (ADR-0014)
   */
  rawContent?: string;
  /** For tool result turns: the ID of the tool call this responds to. */
  toolCallId?: string;
  /** For assistant turns that contain tool calls: the tool calls made. */
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  /**
   * Anthropic only: the raw thinking / redacted_thinking blocks the model
   * emitted with this assistant tool-call turn, captured verbatim (signatures
   * included). With thinking enabled on a tool-use turn, Anthropic requires
   * them echoed back unmodified, first in the assistant content, when the tool
   * results are sent; other providers ignore the field. In-memory only (one
   * generation's tool loop), never persisted.
   */
  anthropicThinkingBlocks?: unknown[];
  /** File attachments (images, future: documents). Only present on user turns. */
  attachments?: Attachment[];
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

/** A local image embedded in an attached note, resolved for vision-capable models. */
export interface NoteImageContextItem {
  noteFilePath: string;
  imageFilePath: string;
  fileName: string;
  mimeType: ImageMimeType;
  data: string;
}

/**
 * Provider-independent chat completion request.
 * Produced by the chat domain, consumed by provider-specific clients.
 */
export interface ChatRequest {
  /** Behavioral instructions (system prompt). Empty string = no system prompt. */
  systemPrompt: string;
  /**
   * Per-mode wording (mode-specific framing + tool guidance) carried in the
   * message tail rather than the cached `system` block, so the cached prefix
   * stays mode-invariant (Layer 1, prompt-cache design §6.1.2). Set only for the
   * billed paths that have a tail mechanism (`anthropic`, `claudecode`); absent
   * for local providers, which keep the wording in `systemPrompt`. Each client
   * places it in its own tail (a `{role:"system"}` / `<system-reminder>` block on
   * the direct API, the user-turn delta on Claude Code).
   */
  modeTail?: string;
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
  /**
   * Runtime allow-list: the tool names the current mode actually permits the model
   * to call (prompt-cache design §6.1.4). Set only when `tools` is the stable cloud
   * superset (the direct Anthropic path), which advertises more than the mode allows
   * so the cached prefix stays warm; the tool loop refuses any call whose name is not
   * here. Absent when the emitted set already equals the allowed set (local providers)
   * or when there are no tools.
   */
  allowedToolNames?: string[];
  /**
   * Layer-2 progressive disclosure (ADR-0009). When set, the Anthropic client prepends the
   * native tool-search entry and marks every tool outside `nonDeferredToolNames` with
   * `defer_loading`, so the long tail loads on demand and stays out of the cached prefix.
   * Set only on the direct `anthropic` agentic path under caching; absent = Layer 1.
   */
  toolSearch?: ToolSearchConfig;
  /** Additional context notes manually attached by the user. */
  additionalContextItems?: AdditionalContextItem[];
  /** Local image embeds resolved from attached notes for vision-capable models only. */
  noteImageContext?: NoteImageContextItem[];
}

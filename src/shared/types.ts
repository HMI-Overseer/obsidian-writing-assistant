import type { EditProposal, AppliedEditRecord } from "../editing/editTypes";
import type { VaultOperationProposal, AppliedVaultOpRecord } from "../vault-ops/types";
import type { VaultOpPolicy } from "../vault-ops/gateway";
import type { ToolCall } from "../tools/types";

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/** MIME types accepted for image attachments. */
export type ImageMimeType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** An image attached to a user message. */
export interface ImageAttachment {
  type: "image";
  /** Unique ID for DOM keying and removal. */
  id: string;
  /** MIME type of the image. */
  mimeType: ImageMimeType;
  /** Base64-encoded image data (no data-URI prefix). */
  data: string;
  /** Original file name, if known. Used for display/alt text. */
  fileName?: string;
  /**
   * Set when this image was embedded in an attached note (vs. user-pasted).
   * Lets clients emit a provenance label and keeps note images frozen in the
   * same snapshot as the note text. Absent for directly attached images.
   */
  sourceNotePath?: string;
}

/**
 * A point-in-time snapshot of a vault note attached to a user message.
 * Frozen at send time so it stays cache-stable in conversation history,
 * rather than being re-read into the system prefix every turn.
 */
export interface NoteAttachment {
  type: "note";
  /** Unique ID for DOM keying and removal. */
  id: string;
  /** File path within the vault at snapshot time. */
  filePath: string;
  /** Display name of the note. */
  fileName: string;
  /** Note content captured at send time (may be truncated to the char budget). */
  content: string;
  /** Whether the snapshot hit the char budget and was truncated. */
  truncated: boolean;
  /** `TFile.stat.mtime` at snapshot time. Drives the composer's "changed since sent" badge. */
  mtimeSnapshot: number;
}

/**
 * A file attachment on a user message.
 * Discriminated union — extend with further attachment kinds later.
 */
export type Attachment = ImageAttachment | NoteAttachment;

// ---------------------------------------------------------------------------
// OpenAI multipart content
// ---------------------------------------------------------------------------

/** A single part in an OpenAI multipart content array. */
export type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIContentPart[] | null;
  /** For tool result messages (OpenAI format). */
  tool_call_id?: string;
  /** For assistant messages with tool calls (OpenAI format). */
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}

export type ProviderOption = "lmstudio" | "openai" | "anthropic" | "claudecode";

export type ModelAvailabilityState = "loaded" | "unloaded" | "unknown" | "cloud";

export type CacheTtl = "default" | "1h";

export interface AnthropicCacheSettings {
  enabled: boolean;
  ttl: CacheTtl;
}

export interface CompletionModel {
  id: string;
  name: string;
  modelId: string;
  provider: ProviderOption;
  /** Optional context window size in tokens. Enables future context-aware truncation. */
  contextWindowSize?: number;
  /** Whether the model was trained for tool/function calling. Only relevant for LM Studio models. */
  trainedForToolUse?: boolean;
  /** Whether the model supports vision (image input). */
  vision?: boolean;
}

/** A named, provider-scoped set of sampling and behavior overrides. */
export interface ProviderProfile {
  id: string;
  name: string;
  provider: ProviderOption;
  isDefault: boolean;

  // Sampling params (nullable = use provider default)
  systemPrompt: string;
  /** When true, all built-in system prompt additions are omitted. Only the profile system prompt is sent. */
  disableBuiltinSystemPrompts: boolean;
  temperature: number;
  maxTokens: number | null;
  topP: number | null;
  topK: number | null;
  minP: number | null;
  repeatPenalty: number | null;
  reasoning: ReasoningLevel | null;

  // Anthropic-specific (present on all profiles, only rendered/used for Anthropic)
  anthropicCacheSettings: AnthropicCacheSettings;
}

export interface EmbeddingModel {
  id: string;
  name: string;
  modelId: string;
  provider: ProviderOption;
}

export interface CustomCommand {
  id: string;
  name: string;
  prompt: string;
  /** Lucide icon name for context menu and settings display. */
  icon?: string;
}

export interface MessageUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  estimatedCostUsd?: number;
}

/** A RAG source reference attached to an assistant message. */
export interface RagSourceRef {
  filePath: string;
  headingPath: string;
  score: number;
  /** Chunk text — populated in memory for hover preview, stripped on persist. */
  content?: string;
  /** Graph entity/relationship annotations — in-memory only, stripped on persist. */
  graphContext?: {
    entities: { name: string; type: string; description: string }[];
    relationships: { source: string; target: string; type: string; description: string }[];
  };
}

export interface MessageVersion {
  content: string;
  createdAt: number;
  /** Usage snapshot for this version's generation. */
  usage?: MessageUsage;
  /** RAG sources used for this version's generation. */
  ragSources?: RagSourceRef[];
}

/** A single step recorded during agentic tool-call execution. Stored with the message but never sent to the API. */
export interface AgenticStep {
  type: "tool_call" | "reasoning";
  round: number;
  /** For tool_call: the tool name identifier (e.g. "semantic_search"). */
  toolName?: string;
  /**
   * For tool_call: the model's tool-call id. Tags the rendered step element so a
   * later pass can find it by id — e.g. the vault-op review attaching inline
   * approve/decline to its write step (a {@link ReviewableVaultOp} carries the
   * same id as `sourceToolCallId`).
   */
  toolCallId?: string;
  /** For tool_call: a human-readable display string of the key argument (e.g. the search query or file path). */
  toolInput?: string;
  /** For tool_call: the full arguments object sent by the model. Used for timeline expansion. */
  toolArgs?: Record<string, unknown>;
  /** For reasoning: the model's prose emitted between tool rounds. */
  text?: string;
}

/**
 * A single message in a conversation transcript.
 * The `id` field provides a stable message identity for editing, branching,
 * and version tracking.
 */
export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Only present on assistant messages that have been regenerated. Stores ALL versions chronologically. */
  versions?: MessageVersion[];
  /** Index into `versions` for the active version. Defaults to last when undefined. */
  activeVersionIndex?: number;
  /** Present when this assistant message contains document edit proposals. */
  editProposal?: EditProposal;
  /** Present after edits from this message have been applied. */
  appliedEdit?: AppliedEditRecord;
  /** Present when this assistant message contains vault-operation proposals (ADR-0002). */
  vaultOpProposal?: VaultOperationProposal;
  /** Present after vault ops from this message have been applied (undo = inverses in reverse). */
  appliedVaultOps?: AppliedVaultOpRecord;
  /** The actual model ID sent to the API (e.g., "claude-sonnet-4-20250514"). */
  modelId?: string;
  /** The provider that generated this message. */
  provider?: ProviderOption;
  /** Token usage and estimated cost for this response. */
  usage?: MessageUsage;
  /** When true, the message content is an error (e.g. API failure). Rendered with error styling. */
  isError?: boolean;
  /** RAG sources used for the active version of this response. */
  ragSources?: RagSourceRef[];
  /** Rewritten retrieval query, when query rewriting changed the original user message. */
  rewrittenQuery?: string;
  /** Raw tool calls from the model response (edit mode with tool use). */
  toolCalls?: ToolCall[];
  /** Agentic tool-call timeline for this response. Stored for display; never sent to the API. */
  agenticSteps?: AgenticStep[];
  /** File attachments on user messages (images and note snapshots). */
  attachments?: Attachment[];
}

/**
 * A full conversation record stored in history.
 *
 * `parentConversationId` and `branchFromMessageId` are reserved for future
 * branch-off support (create a new conversation forked from a specific bubble).
 * They are undefined on normal conversations.
 */
export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** CompletionModel.id selected for this conversation. */
  modelId: string;
  /** Display snapshot that survives model rename or deletion. */
  modelName: string;
  messages: ConversationMessage[];
  draft: string;
  /** Reserved for future branching support. */
  parentConversationId?: string;
  /** Reserved for future branching support. */
  branchFromMessageId?: string;
}

/** Lightweight metadata stored in the settings index (no message content). */
export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  modelId: string;
  modelName: string;
  messageCount: number;
}

export interface ChatHistory {
  conversations: ConversationMeta[];
  activeConversationId: string | null;
}

export type ReasoningLevel = "off" | "low" | "medium" | "high" | "on";

/** Sampling parameters sent to the LM Studio API. */
export interface SamplingParams {
  temperature: number;
  maxTokens: number | null;
  topP: number | null;
  topK: number | null;
  minP: number | null;
  repeatPenalty: number | null;
  reasoning: ReasoningLevel | null;
}

export interface LMStudioProviderSettings {
  baseUrl: string;
  bypassCors: boolean;
}

export interface AnthropicProviderSettings {
  apiKey: string;
}

export interface OpenAIProviderSettings {
  apiKey: string;
  baseUrl: string;
}

export interface ClaudeCodeProviderSettings {
  /**
   * Optional explicit path to the `claude` binary. Empty = resolve from PATH.
   * Not a secret — authentication uses the user's existing `claude` login session.
   */
  claudePath: string;
}

export interface ProviderSettingsMap {
  lmstudio: LMStudioProviderSettings;
  anthropic: AnthropicProviderSettings;
  openai: OpenAIProviderSettings;
  claudecode: ClaudeCodeProviderSettings;
}

/** RAG-specific settings. */
export interface RagSettings {
  enabled: boolean;
  /** EmbeddingModel.id from the embeddingModels array. */
  activeEmbeddingModelId: string | null;
  /** Target chunk size in characters. */
  chunkSize: number;
  /** Overlap between chunks in characters. */
  chunkOverlap: number;
  /** Number of retrieval results to inject as context. */
  topK: number;
  /** Maximum chunks from a single file in retrieval results. */
  maxChunksPerFile: number;
  /** Minimum similarity score (0–1) to include a result. */
  minScore: number;
  /** File patterns to exclude from indexing (glob strings). */
  excludePatterns: string[];
  /** Maximum total characters of RAG context to inject into a prompt. */
  maxContextChars: number;
  /** Enrich embedding text with tags, folder path, and wikilink targets for disambiguation. */
  metadataEnrichment: boolean;
}

/** Knowledge graph settings. */
export interface KnowledgeGraphSettings {
  enabled: boolean;
  /** CompletionModel.id — the chat model used for entity extraction. */
  activeCompletionModelId: string | null;
  /** EmbeddingModel.id — required for generating entity vectors at build time. */
  activeEmbeddingModelId: string | null;
  /** Glob patterns to exclude from graph extraction. */
  excludePatterns: string[];
}

/** Snapshot of the conditions a benchmark run executed under. Makes runs comparable later. */
export interface BenchmarkRunConditions {
  provider: ProviderOption;
  modelId: string;
  modelName: string;
  profileName: string;
  samplingParams: SamplingParams;
  pluginVersion: string;
  /** Unix epoch ms when the run started. */
  timestamp: number;
  iterationCount: number;
}

/** Condensed per-test outcome stored in benchmark history. Raw responses are never persisted. */
export interface BenchmarkHistoryTestResult {
  testId: string;
  testName: string;
  suiteId: string;
  passCount: number;
  totalCount: number;
  avgDurationMs: number;
  isControl: boolean;
  /** Present when the test aborted with a request/transport error. */
  error?: string;
}

/** A persisted benchmark run: conditions plus condensed results. */
export interface BenchmarkHistoryEntry {
  id: string;
  conditions: BenchmarkRunConditions;
  results: BenchmarkHistoryTestResult[];
}

export interface BenchmarkSettings {
  /** Vault folder where exported benchmark reports are created. */
  reportFolder: string;
  /** Recent benchmark runs, newest first, capped at MAX_BENCHMARK_HISTORY. */
  history: BenchmarkHistoryEntry[];
}

export interface PluginSettings {
  providerSettings: ProviderSettingsMap;
  includeNoteContext: boolean;
  includeLocalAttachmentsAsContext: boolean;
  maxContextChars: number;
  completionModels: CompletionModel[];
  embeddingModels: EmbeddingModel[];
  commands: CustomCommand[];
  chatHistory: ChatHistory;
  /** Provider-scoped parameter profiles. */
  providerProfiles: ProviderProfile[];
  /** Active profile ID per provider. */
  activeProfileIds: Record<ProviderOption, string>;
  /** Number of context lines shown above/below each diff hunk. */
  diffContextLines: number;
  /** Minimum fuzzy match confidence (0–1) to consider a match valid. */
  diffMinMatchConfidence: number;
  /** RAG (retrieval-augmented generation) settings. */
  rag: RagSettings;
  /** Knowledge graph settings. */
  knowledgeGraph: KnowledgeGraphSettings;
  /** System prompt prefix for Plan mode. Prepended before user's custom prompt. */
  planSystemPromptPrefix: string;
  /** System prompt prefix for Chat mode. Prepended before user's custom prompt. */
  chatSystemPromptPrefix: string;
  /** System prompt prefix for Edit mode (tool use variant). Prepended before user's custom prompt. */
  editToolSystemPromptPrefix: string;
  /** System prompt prefix for Edit mode (fallback SEARCH/REPLACE variant). Prepended before user's custom prompt. */
  editFallbackSystemPromptPrefix: string;
  /** Whether the user has accepted the API keys privacy disclaimer. */
  apiKeysDisclaimerAccepted: boolean;
  /** Master gate for all tool use. When false, no mode uses tools. */
  agenticMode: boolean;
  /** Use structured edit tools in edit mode when agentic mode is on and model supports them. */
  preferToolUse: boolean;
  /** Maximum read-only tool rounds in edit mode (outline inspect → write). */
  maxToolRoundsEdit: number;
  /** Maximum read-only tool rounds in chat/plan mode (multi-hop vault retrieval). */
  maxToolRoundsChat: number;
  /** Benchmark report folder and persisted run history. */
  benchmark: BenchmarkSettings;
  /** Approval policy for vault write operations (create/overwrite/move/trash/createDir). */
  vaultOpPolicy: VaultOpPolicy;
}

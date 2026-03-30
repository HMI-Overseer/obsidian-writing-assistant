import type { EditProposal, AppliedEditRecord } from "../editing/editTypes";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export type ProviderOption = "lmstudio" | "openai" | "anthropic";

export interface CompletionModel {
  id: string;
  name: string;
  modelId: string;
  provider: ProviderOption;
  /** Optional context window size in tokens. Enables future context-aware truncation. */
  contextWindowSize?: number;
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
  autoInsert: boolean;
}

export interface MessageUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  estimatedCostUsd?: number;
}

export interface MessageVersion {
  content: string;
  createdAt: number;
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
  /** The actual model ID sent to the API (e.g., "claude-sonnet-4-20250514"). */
  modelId?: string;
  /** The provider that generated this message. */
  provider?: ProviderOption;
  /** Token usage and estimated cost for this response. */
  usage?: MessageUsage;
  /** When true, the message content is an error (e.g. API failure). Rendered with error styling. */
  isError?: boolean;
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

export interface ChatHistory {
  conversations: Conversation[];
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

export interface ProviderSettingsMap {
  lmstudio: LMStudioProviderSettings;
  anthropic: AnthropicProviderSettings;
  openai: OpenAIProviderSettings;
}

export interface PluginSettings {
  /** @deprecated Use providerSettings.lmstudio.baseUrl */
  lmStudioUrl: string;
  /** @deprecated Use providerSettings.lmstudio.bypassCors */
  bypassCors: boolean;
  providerSettings: ProviderSettingsMap;
  includeNoteContext: boolean;
  maxContextChars: number;
  completionModels: CompletionModel[];
  embeddingModels: EmbeddingModel[];
  commands: CustomCommand[];
  chatHistory: ChatHistory;
  /** Global system prompt sent before each chat request. */
  globalSystemPrompt: string;
  /** Global temperature for chat completions (0–1). */
  globalTemperature: number;
  /** Maximum tokens to generate (null = model default). */
  globalMaxTokens: number | null;
  /** Top-p / nucleus sampling (null = model default). */
  globalTopP: number | null;
  /** Top-k sampling (null = model default). */
  globalTopK: number | null;
  /** Min-p sampling threshold (null = model default). */
  globalMinP: number | null;
  /** Repeat penalty (null = model default). */
  globalRepeatPenalty: number | null;
  /** Reasoning level (null = model default). */
  globalReasoning: ReasoningLevel | null;
  /** Number of context lines shown above/below each diff hunk. */
  diffContextLines: number;
  /** Minimum fuzzy match confidence (0–1) to consider a match valid. */
  diffMinMatchConfidence: number;
}

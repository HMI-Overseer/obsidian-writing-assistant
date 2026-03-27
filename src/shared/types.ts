export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatState {
  messages: Message[];
  draft: string;
}

export interface CompletionModel {
  id: string;
  name: string;
  modelId: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
}

export interface LMStudioModel {
  id: string;
  key: string;
  displayName: string;
  type?: string;
  publisher?: string;
  ownedBy?: string;
  state: "loaded" | "available";
  isLoaded: boolean;
  architecture?: string;
  quantization?: LMStudioQuantization;
  sizeBytes?: number;
  paramsString?: string | null;
  loadedInstances: LMStudioLoadedInstance[];
  maxContextLength?: number;
  format?: string;
  capabilities?: LMStudioModelCapabilities;
  description?: string | null;
  variants?: string[];
  selectedVariant?: string;
}

export type LMStudioModelKind = "completion" | "embedding";

export interface LMStudioModelDigest {
  id: string;
  kind: LMStudioModelKind;
  displayName: string;
  targetModelId: string;
  isLoaded: boolean;
  activeContextLength?: number;
  maxContextLength?: number;
  summary?: string;
}

export interface LMStudioQuantization {
  name?: string;
  bitsPerWeight?: number;
}

export interface LMStudioLoadedInstanceConfig {
  contextLength?: number;
  evalBatchSize?: number;
  parallel?: number;
  flashAttention?: boolean;
  offloadKvCacheToGpu?: boolean;
}

export interface LMStudioLoadedInstance {
  id: string;
  config?: LMStudioLoadedInstanceConfig;
}

export interface LMStudioModelCapabilities {
  vision?: boolean;
  trainedForToolUse?: boolean;
}

export interface EmbeddingModel {
  id: string;
  name: string;
  modelId: string;
}

export interface CustomCommand {
  id: string;
  name: string;
  prompt: string;
  autoInsert: boolean;
}

/**
 * A single message in a conversation transcript.
 * The `id` field is intentionally included now so that future branching and
 * in-place bubble editing can reference a stable message identity without
 * requiring a schema migration.
 */
export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
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

export interface PluginSettings {
  lmStudioUrl: string;
  bypassCors: boolean;
  includeNoteContext: boolean;
  maxContextChars: number;
  completionModels: CompletionModel[];
  embeddingModels: EmbeddingModel[];
  commands: CustomCommand[];
  chatHistory: ChatHistory;
  /** @deprecated Kept only for one-time migration from the pre-history schema. */
  chatState?: ChatState;
}

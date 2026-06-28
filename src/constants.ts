import type { BenchmarkSettings, ChatHistory, KnowledgeGraphSettings, PluginSettings, ProviderOption, ProviderProfile, RagSettings } from "./shared/types";
import { DEFAULT_VAULT_OP_POLICY } from "./vault-ops/gateway";
import type { ImageMimeType } from "./shared/types";

export const VIEW_TYPE_CHAT = "writing-assistant-chat";

export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful creative writing assistant. Be concise, specific, and match the tone of the existing text.";

export const DEFAULT_COMPLETION_TEMPERATURE = 0.7;
export const DEFAULT_COMPLETION_MAX_TOKENS = 2000;

export const MAX_CONVERSATIONS = 50;

export const CONTEXT_WARNING_THRESHOLD = 0.80;
export const CONTEXT_DANGER_THRESHOLD = 0.95;

export const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB
export const SUPPORTED_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
]);
export const SUPPORTED_IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, ImageMimeType>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};
export const MAX_NOTE_CONTEXT_IMAGES = 4;
export const MAX_NOTE_CONTEXT_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_NOTE_CONTEXT_TOTAL_BYTES = 12 * 1024 * 1024; // 12 MB

export const DEFAULT_CHAT_HISTORY: ChatHistory = {
  conversations: [],
  activeConversationId: null,
};

export const DEFAULT_RAG_SETTINGS: RagSettings = {
  enabled: false,
  activeEmbeddingModelId: null,
  chunkSize: 1500,
  chunkOverlap: 200,
  topK: 5,
  maxChunksPerFile: 5,
  minScore: 0.3,
  excludePatterns: ["templates/**"],
  maxContextChars: 6000,
  metadataEnrichment: true,
};

export const DEFAULT_KNOWLEDGE_GRAPH_SETTINGS: KnowledgeGraphSettings = {
  enabled: false,
  activeCompletionModelId: null,
  activeEmbeddingModelId: null,
  excludePatterns: ["templates/**"],
};

// The unified system prompt prefix (the plan/chat/edit modes are gone, §6.3). Edit
// capability rides the dynamic tool/regex guidance, so the prefix stays general.
export const DEFAULT_SYSTEM_PROMPT_PREFIX =
  "When asked to research, explore, or find information, search exhaustively before answering. " +
  "Use multiple rounds of tool calls if needed, and synthesize only after you have gathered enough context.";

// A high backstop, not the primary spin control (D5): the per-turn identical-call
// guard in the tool loop catches a model repeating the same call; the round cap
// only stops genuinely unbounded multi-hop work. A budget of 5 was too small and
// cut off legitimate read → read → edit chains, so it is raised well clear of them.
export const DEFAULT_MAX_TOOL_ROUNDS_EDIT = 15;
export const DEFAULT_MAX_TOOL_ROUNDS_CHAT = 20;

/** Maximum persisted benchmark runs. Oldest entries are dropped beyond this. */
export const MAX_BENCHMARK_HISTORY = 50;

export const DEFAULT_BENCHMARK_SETTINGS: BenchmarkSettings = {
  reportFolder: "Benchmarks",
  history: [],
};

export const DEFAULT_ACTIVE_PROFILE_IDS: Record<ProviderOption, string> = {
  lmstudio: "lmstudio-default",
  anthropic: "anthropic-default",
  openai: "openai-default",
  claudecode: "claudecode-default",
};

export function makeDefaultProfile(provider: ProviderOption): ProviderProfile {
  return {
    id: `${provider}-default`,
    name: "Default",
    provider,
    isDefault: true,
    systemPrompt: "",
    disableBuiltinSystemPrompts: false,
    temperature: DEFAULT_COMPLETION_TEMPERATURE,
    maxTokens: provider === "anthropic" ? DEFAULT_COMPLETION_MAX_TOKENS : null,
    topP: null,
    topK: null,
    minP: null,
    repeatPenalty: null,
    reasoning: null,
    anthropicCacheSettings: { enabled: false, ttl: "default" },
  };
}

export const DEFAULT_SETTINGS: PluginSettings = {
  providerSettings: {
    lmstudio: { baseUrl: "http://localhost:1234/v1", bypassCors: true },
    anthropic: { apiKey: "" },
    openai: { apiKey: "", baseUrl: "https://api.openai.com/v1" },
    claudecode: { claudePath: "" },
  },
  includeNoteContext: true,
  includeLocalAttachmentsAsContext: false,
  // ~4000 words: holds the bulk of single chapters in one budget so a long note
  // is not silently truncated. Truncation only triggers on notes that actually
  // exceed this, so short notes incur no extra cost. User-tunable in the General
  // tab.
  maxContextChars: 24000,
  providerProfiles: [],
  activeProfileIds: { ...DEFAULT_ACTIVE_PROFILE_IDS },
  completionModels: [],
  embeddingModels: [],
  commands: [],
  chatHistory: { ...DEFAULT_CHAT_HISTORY },
  diffContextLines: 3,
  diffMinMatchConfidence: 0.7,
  rag: { ...DEFAULT_RAG_SETTINGS },
  knowledgeGraph: { ...DEFAULT_KNOWLEDGE_GRAPH_SETTINGS },
  systemPromptPrefix: DEFAULT_SYSTEM_PROMPT_PREFIX,
  apiKeysDisclaimerAccepted: false,
  agenticMode: false,
  preferToolUse: false,
  maxToolRoundsEdit: DEFAULT_MAX_TOOL_ROUNDS_EDIT,
  maxToolRoundsChat: DEFAULT_MAX_TOOL_ROUNDS_CHAT,
  benchmark: { ...DEFAULT_BENCHMARK_SETTINGS },
  vaultOpPolicy: { ...DEFAULT_VAULT_OP_POLICY, scopes: [...DEFAULT_VAULT_OP_POLICY.scopes] },
};

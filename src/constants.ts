import type { ChatHistory, KnowledgeGraphSettings, PluginSettings, RagSettings } from "./shared/types";
import { EDIT_SYSTEM_PROMPT } from "./editing/editSystemPrompt";
import { TOOL_EDIT_SYSTEM_PROMPT } from "./tools/editing/systemPrompt";

export const VIEW_TYPE_CHAT = "lm-studio-chat";

export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful creative writing assistant. Be concise, specific, and match the tone of the existing text.";

export const DEFAULT_COMPLETION_TEMPERATURE = 0.7;
export const DEFAULT_COMPLETION_MAX_TOKENS = 2000;

export const MAX_CONVERSATIONS = 50;

export const CONTEXT_WARNING_THRESHOLD = 0.80;
export const CONTEXT_DANGER_THRESHOLD = 0.95;

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

export const DEFAULT_SETTINGS: PluginSettings = {
  lmStudioUrl: "http://localhost:1234/v1",
  bypassCors: true,
  providerSettings: {
    lmstudio: { baseUrl: "http://localhost:1234/v1", bypassCors: true },
    anthropic: { apiKey: "" },
    openai: { apiKey: "", baseUrl: "https://api.openai.com/v1" },
  },
  includeNoteContext: true,
  maxContextChars: 12000,
  globalSystemPrompt: "",
  globalTemperature: 0.7,
  globalMaxTokens: 2000,
  globalTopP: null,
  globalTopK: null,
  globalMinP: null,
  globalRepeatPenalty: null,
  globalReasoning: null,
  completionModels: [],
  embeddingModels: [],
  commands: [],
  chatHistory: { ...DEFAULT_CHAT_HISTORY },
  diffContextLines: 3,
  diffMinMatchConfidence: 0.7,
  rag: { ...DEFAULT_RAG_SETTINGS },
  knowledgeGraph: { ...DEFAULT_KNOWLEDGE_GRAPH_SETTINGS },
  planSystemPromptPrefix: "",
  chatSystemPromptPrefix: "",
  editToolSystemPromptPrefix: TOOL_EDIT_SYSTEM_PROMPT,
  editFallbackSystemPromptPrefix: EDIT_SYSTEM_PROMPT,
  preferToolUse: false,
};

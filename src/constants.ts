import type { ChatHistory, PluginSettings } from "./shared/types";

export const VIEW_TYPE_CHAT = "lm-studio-chat";

export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful creative writing assistant. Be concise, specific, and match the tone of the existing text.";

export const DEFAULT_COMPLETION_TEMPERATURE = 0.7;
export const DEFAULT_COMPLETION_MAX_TOKENS = 2000;

export const MAX_CONVERSATIONS = 50;

export const DEFAULT_CHAT_HISTORY: ChatHistory = {
  conversations: [],
  activeConversationId: null,
};

export const DEFAULT_SETTINGS: PluginSettings = {
  lmStudioUrl: "http://localhost:1234/v1",
  bypassCors: true,
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
};

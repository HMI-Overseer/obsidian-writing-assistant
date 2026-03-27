import type { ChatHistory, PluginSettings } from "./shared/types";

export const VIEW_TYPE_CHAT = "lm-studio-chat";

export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful creative writing assistant. Be concise, specific, and match the tone of the existing text.";

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
  completionModels: [],
  embeddingModels: [],
  commands: [],
  chatHistory: { ...DEFAULT_CHAT_HISTORY },
};

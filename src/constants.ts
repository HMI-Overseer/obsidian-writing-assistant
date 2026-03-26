import type { CompletionModel, PluginSettings } from "./shared/types";

export const VIEW_TYPE_CHAT = "lm-studio-chat";

export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful creative writing assistant. Be concise, specific, and match the tone of the existing text.";

export const DEFAULT_COMPLETION_MODEL: CompletionModel = {
  id: "default",
  name: "Default",
  modelId: "",
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  temperature: 0.7,
  maxTokens: 2000,
};

export const DEFAULT_SETTINGS: PluginSettings = {
  lmStudioUrl: "http://localhost:1234/v1",
  bypassCors: true,
  includeNoteContext: true,
  maxContextChars: 12000,
  activeCompletionModelId: "default",
  completionModels: [{ ...DEFAULT_COMPLETION_MODEL }],
  embeddingModels: [],
  commands: [],
  chatState: {
    messages: [],
    draft: "",
  },
};

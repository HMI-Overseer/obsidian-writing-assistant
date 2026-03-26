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

export interface PluginSettings {
  lmStudioUrl: string;
  bypassCors: boolean;
  includeNoteContext: boolean;
  maxContextChars: number;
  activeCompletionModelId: string;
  completionModels: CompletionModel[];
  embeddingModels: EmbeddingModel[];
  commands: CustomCommand[];
  chatState: ChatState;
}

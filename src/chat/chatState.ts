import type { ChatState, Message } from "../shared/types";

export const CHAT_DRAFT_SAVE_DELAY_MS = 300;
export type ChatTranscriptMessage = { role: "user" | "assistant"; content: string };

export function normalizeChatState(raw?: Partial<ChatState> | null): ChatState {
  const messages: Message[] = Array.isArray(raw?.messages)
    ? raw.messages
        .filter(
          (message): message is Message =>
            !!message &&
            (message.role === "user" ||
              message.role === "assistant" ||
              message.role === "system") &&
            typeof message.content === "string"
        )
        .map((message) => ({
          role: message.role,
          content: message.content,
        }))
    : [];

  return {
    messages,
    draft: typeof raw?.draft === "string" ? raw.draft : "",
  };
}

export function hydrateTranscript(chatState: ChatState): {
  draft: string;
  messages: ChatTranscriptMessage[];
  lastAssistantResponse: string;
} {
  const messages = chatState.messages.filter(
    (message): message is ChatTranscriptMessage =>
      message.role === "user" || message.role === "assistant"
  );

  const lastAssistantResponse =
    [...messages].reverse().find((message) => message.role === "assistant")?.content ?? "";

  return {
    draft: chatState.draft,
    messages,
    lastAssistantResponse,
  };
}

export function createChatState(messages: ChatTranscriptMessage[], draft: string): ChatState {
  return {
    messages: [...messages],
    draft,
  };
}

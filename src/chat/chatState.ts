import type { ChatState, ConversationMessage, Message } from "../shared/types";

export const CHAT_DRAFT_SAVE_DELAY_MS = 300;

/**
 * @deprecated Use ConversationMessage from types.ts for new code.
 * Kept as an alias so existing call-sites that haven't been updated yet still compile.
 */
export type ChatTranscriptMessage = ConversationMessage;

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

import { MAX_CONVERSATIONS } from "../../constants";
import type { ChatHistory, Conversation, ConversationMessage } from "../../shared/types";
import { generateId } from "../../utils";

export function generateConversationTitle(firstUserMessage: string): string {
  const cleaned = firstUserMessage.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 60) return cleaned;

  const truncated = cleaned.slice(0, 60);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 30 ? truncated.slice(0, lastSpace) : truncated) + "...";
}

export function makeMessage(
  role: "user" | "assistant",
  content: string
): ConversationMessage {
  return { id: generateId(), role, content };
}

export function createConversation(modelId: string, modelName: string): Conversation {
  const now = Date.now();
  return {
    id: generateId(),
    title: "",
    createdAt: now,
    updatedAt: now,
    modelId,
    modelName,
    messages: [],
    draft: "",
  };
}

export function normalizeChatHistory(raw: unknown): ChatHistory {
  if (!raw || typeof raw !== "object") {
    return { conversations: [], activeConversationId: null };
  }

  const obj = raw as Record<string, unknown>;

  const conversations: Conversation[] = Array.isArray(obj.conversations)
    ? obj.conversations
        .filter((conversation): conversation is Record<string, unknown> => {
          return !!conversation && typeof conversation === "object";
        })
        .map(normalizeConversation)
        .filter((conversation): conversation is Conversation => conversation !== null)
    : [];

  const activeConversationId =
    typeof obj.activeConversationId === "string" &&
    conversations.some((conversation) => conversation.id === obj.activeConversationId)
      ? obj.activeConversationId
      : (conversations[0]?.id ?? null);

  return { conversations, activeConversationId };
}

function normalizeConversation(raw: Record<string, unknown>): Conversation | null {
  const id = typeof raw.id === "string" && raw.id ? raw.id : generateId();
  const title = typeof raw.title === "string" ? raw.title : "";
  const now = Date.now();
  const createdAt = typeof raw.createdAt === "number" ? raw.createdAt : now;
  const updatedAt = typeof raw.updatedAt === "number" ? raw.updatedAt : now;
  const modelId = typeof raw.modelId === "string" ? raw.modelId : "";
  const modelName = typeof raw.modelName === "string" ? raw.modelName : "Unknown";
  const draft = typeof raw.draft === "string" ? raw.draft : "";

  const messages: ConversationMessage[] = Array.isArray(raw.messages)
    ? raw.messages
        .filter((message): message is Record<string, unknown> => {
          return (
            !!message &&
            typeof message === "object" &&
            (message.role === "user" || message.role === "assistant") &&
            typeof message.content === "string"
          );
        })
        .map((message) => ({
          id: typeof message.id === "string" && message.id ? message.id : generateId(),
          role: message.role as "user" | "assistant",
          content: message.content as string,
        }))
    : [];

  return { id, title, createdAt, updatedAt, modelId, modelName, messages, draft };
}

export function pruneHistory(history: ChatHistory): boolean {
  if (history.conversations.length <= MAX_CONVERSATIONS) return false;

  const sorted = [...history.conversations].sort(
    (left, right) => left.updatedAt - right.updatedAt
  );
  const toRemove = new Set<string>();

  for (const conversation of sorted) {
    if (history.conversations.length - toRemove.size <= MAX_CONVERSATIONS) break;
    if (conversation.id !== history.activeConversationId) {
      toRemove.add(conversation.id);
    }
  }

  history.conversations = history.conversations.filter(
    (conversation) => !toRemove.has(conversation.id)
  );
  return toRemove.size > 0;
}

export function formatRelativeDate(timestamp: number): string {
  const now = new Date();
  const date = new Date(timestamp);

  const todayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  ).getTime();
  const yesterdayStart = todayStart - 86400000;
  const weekStart = todayStart - 6 * 86400000;

  if (timestamp >= todayStart) return "Today";
  if (timestamp >= yesterdayStart) return "Yesterday";

  if (timestamp >= weekStart) {
    return date.toLocaleDateString([], { weekday: "short" });
  }

  const currentYear = now.getFullYear();
  if (date.getFullYear() === currentYear) {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  return date.toLocaleDateString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

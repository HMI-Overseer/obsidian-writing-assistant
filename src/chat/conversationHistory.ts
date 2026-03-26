import type { ChatHistory, Conversation, ConversationMessage } from "../shared/types";
import { MAX_CONVERSATIONS } from "../constants";
import { generateId } from "../utils";

// ---------------------------------------------------------------------------
// Title generation
// ---------------------------------------------------------------------------

export function generateConversationTitle(firstUserMessage: string): string {
  const cleaned = firstUserMessage.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 60) return cleaned;
  const truncated = cleaned.slice(0, 60);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 30 ? truncated.slice(0, lastSpace) : truncated) + "…";
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

export function makeMessage(
  role: "user" | "assistant",
  content: string
): ConversationMessage {
  return { id: generateId(), role, content };
}

// ---------------------------------------------------------------------------
// Conversation creation
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// History normalisation (used when loading from disk)
// ---------------------------------------------------------------------------

export function normalizeChatHistory(raw: unknown): ChatHistory {
  if (!raw || typeof raw !== "object") {
    return { conversations: [], activeConversationId: null };
  }

  const obj = raw as Record<string, unknown>;

  const conversations: Conversation[] = Array.isArray(obj.conversations)
    ? obj.conversations
        .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
        .map(normalizeConversation)
        .filter((c): c is Conversation => c !== null)
    : [];

  const activeConversationId =
    typeof obj.activeConversationId === "string" &&
    conversations.some((c) => c.id === obj.activeConversationId)
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
        .filter(
          (m): m is Record<string, unknown> =>
            !!m &&
            typeof m === "object" &&
            (m.role === "user" || m.role === "assistant") &&
            typeof m.content === "string"
        )
        .map((m) => ({
          id: typeof m.id === "string" && m.id ? m.id : generateId(),
          role: m.role as "user" | "assistant",
          content: m.content as string,
        }))
    : [];

  return { id, title, createdAt, updatedAt, modelId, modelName, messages, draft };
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

/**
 * Ensures the history never exceeds MAX_CONVERSATIONS.
 * Removes the oldest conversations by updatedAt, never removing activeId.
 * Returns true if any pruning occurred.
 */
export function pruneHistory(history: ChatHistory): boolean {
  if (history.conversations.length <= MAX_CONVERSATIONS) return false;

  const sorted = [...history.conversations].sort((a, b) => a.updatedAt - b.updatedAt);
  const toRemove = new Set<string>();

  for (const conv of sorted) {
    if (history.conversations.length - toRemove.size <= MAX_CONVERSATIONS) break;
    if (conv.id !== history.activeConversationId) {
      toRemove.add(conv.id);
    }
  }

  history.conversations = history.conversations.filter((c) => !toRemove.has(c.id));
  return toRemove.size > 0;
}

// ---------------------------------------------------------------------------
// Relative date formatting for list items
// ---------------------------------------------------------------------------

export function formatRelativeDate(timestamp: number): string {
  const now = new Date();
  const date = new Date(timestamp);

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400000;
  const weekStart = todayStart - 6 * 86400000;

  if (timestamp >= todayStart) return "Today";
  if (timestamp >= yesterdayStart) return "Yesterday";

  const timeStr = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const _ = timeStr; // suppress unused

  if (timestamp >= weekStart) {
    return date.toLocaleDateString([], { weekday: "short" });
  }

  const currentYear = now.getFullYear();
  if (date.getFullYear() === currentYear) {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  return date.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

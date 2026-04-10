import { MAX_CONVERSATIONS } from "../../constants";
import type {
  ChatHistory,
  Conversation,
  ConversationMeta,
  ConversationMessage,
  MessageVersion,
} from "../../shared/types";
import { generateId } from "../../utils";

export function generateConversationTitle(firstUserMessage: string): string {
  const cleaned = firstUserMessage.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 60) return cleaned;

  const truncated = cleaned.slice(0, 60);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 30 ? truncated.slice(0, lastSpace) : truncated) + "...";
}

export function makeMessage(role: "user" | "assistant", content: string): ConversationMessage {
  return { id: generateId(), role, content };
}

export function toConversationMeta(conversation: Conversation): ConversationMeta {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    modelId: conversation.modelId,
    modelName: conversation.modelName,
    messageCount: conversation.messages.length,
  };
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

  const conversations: ConversationMeta[] = Array.isArray(obj.conversations)
    ? obj.conversations
        .filter((entry): entry is Record<string, unknown> => {
          return !!entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).id === "string";
        })
        .map(normalizeConversationMeta)
    : [];

  const activeConversationId =
    typeof obj.activeConversationId === "string" &&
    conversations.some((meta) => meta.id === obj.activeConversationId)
      ? obj.activeConversationId
      : (conversations[0]?.id ?? null);

  return { conversations, activeConversationId };
}

function normalizeConversationMeta(raw: Record<string, unknown>): ConversationMeta {
  const now = Date.now();
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : generateId(),
    title: typeof raw.title === "string" ? raw.title : "",
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : now,
    modelId: typeof raw.modelId === "string" ? raw.modelId : "",
    modelName: typeof raw.modelName === "string" ? raw.modelName : "Unknown",
    messageCount: typeof raw.messageCount === "number" ? raw.messageCount : 0,
  };
}

export function normalizeConversation(raw: Record<string, unknown>): Conversation | null {
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
        .map((message) => {
          const base: ConversationMessage = {
            id: typeof message.id === "string" && message.id ? message.id : generateId(),
            role: message.role as "user" | "assistant",
            content: message.content as string,
          };

          if (Array.isArray(message.versions)) {
            const validVersions = message.versions.filter(
              (v): v is MessageVersion =>
                !!v &&
                typeof v === "object" &&
                typeof (v as Record<string, unknown>).content === "string" &&
                typeof (v as Record<string, unknown>).createdAt === "number"
            );
            if (validVersions.length > 0) {
              base.versions = validVersions;
              const rawIndex = message.activeVersionIndex;
              base.activeVersionIndex =
                typeof rawIndex === "number" && rawIndex >= 0 && rawIndex < validVersions.length
                  ? rawIndex
                  : validVersions.length - 1;
            }
          }

          // Preserve edit proposal and applied edit records if present
          if (message.editProposal && typeof message.editProposal === "object") {
            base.editProposal = message.editProposal as ConversationMessage["editProposal"];
          }
          if (message.appliedEdit && typeof message.appliedEdit === "object") {
            base.appliedEdit = message.appliedEdit as ConversationMessage["appliedEdit"];
          }

          // Preserve per-message model identity and usage
          if (typeof message.modelId === "string") base.modelId = message.modelId;
          if (typeof message.provider === "string") base.provider = message.provider as ConversationMessage["provider"];
          if (message.usage && typeof message.usage === "object") {
            base.usage = message.usage as ConversationMessage["usage"];
          }
          if (message.isError === true) base.isError = true;
          if (Array.isArray(message.ragSources)) {
            base.ragSources = message.ragSources as ConversationMessage["ragSources"];
          }
          if (typeof message.rewrittenQuery === "string") {
            base.rewrittenQuery = message.rewrittenQuery;
          }
          if (Array.isArray(message.agenticSteps)) {
            base.agenticSteps = message.agenticSteps as ConversationMessage["agenticSteps"];
          }

          return base;
        })
    : [];

  return { id, title, createdAt, updatedAt, modelId, modelName, messages, draft };
}

/** Prune oldest conversations beyond the cap. Returns IDs of removed entries. */
export function pruneHistory(history: ChatHistory): string[] {
  if (history.conversations.length <= MAX_CONVERSATIONS) return [];

  const sorted = [...history.conversations].sort((left, right) => left.updatedAt - right.updatedAt);
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
  return [...toRemove];
}

export function createBranchConversation(
  source: ConversationMeta,
  messagesUpTo: ConversationMessage[],
  branchMessageId: string
): Conversation {
  const branch = createConversation(source.modelId, source.modelName);
  branch.title = `Branch of ${source.title || "Untitled"}`;
  branch.messages = structuredClone(messagesUpTo);
  branch.parentConversationId = source.id;
  branch.branchFromMessageId = branchMessageId;
  return branch;
}

export function formatRelativeDate(timestamp: number): string {
  const now = new Date();
  const date = new Date(timestamp);

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
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

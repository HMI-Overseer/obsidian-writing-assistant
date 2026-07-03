import { MAX_CONVERSATIONS } from "../../constants";
import type {
  Attachment,
  ChatHistory,
  Conversation,
  ConversationMeta,
  ConversationMessage,
  MessageVersion,
} from "../../shared/types";
import type { AppliedEditRecord, EditProposal } from "../../editing/editTypes";
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

          // Preserve edit proposals + applied records, migrating the legacy single-file
          // fields into the ADR-0010 arrays so the in-memory model is always plural
          // (read sites need not know which format a conversation was saved in).
          const editProposals = migrateEditProposals(message);
          if (editProposals.length > 0) base.editProposals = editProposals;
          const appliedEdits = migrateAppliedEdits(message);
          if (appliedEdits.length > 0) base.appliedEdits = appliedEdits;

          // Preserve vault-op proposal and applied records if present and valid
          if (isValidVaultOpProposal(message.vaultOpProposal)) {
            base.vaultOpProposal = message.vaultOpProposal as ConversationMessage["vaultOpProposal"];
          }
          if (isValidAppliedVaultOpRecord(message.appliedVaultOps)) {
            base.appliedVaultOps = message.appliedVaultOps as ConversationMessage["appliedVaultOps"];
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
          if (Array.isArray(message.attachments)) {
            const valid = (message.attachments as unknown[]).filter(isValidAttachment);
            if (valid.length > 0) base.attachments = valid;
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

/**
 * Validate a persisted attachment, discriminating on `type`:
 * `image` requires base64 `data`, `note` requires snapshot `content`.
 */
function isValidAttachment(value: unknown): value is Attachment {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  if (typeof a.id !== "string") return false;
  if (a.type === "image") return typeof a.data === "string";
  if (a.type === "note") return typeof a.content === "string";
  return false;
}

function isValidEditProposal(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    typeof obj.targetFilePath === "string" &&
    typeof obj.documentSnapshot === "string" &&
    typeof obj.snapshotTimestamp === "number" &&
    typeof obj.prose === "string" &&
    Array.isArray(obj.hunks)
  );
}

function isValidAppliedEditRecord(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.proposalId === "string" &&
    typeof obj.targetFilePath === "string" &&
    Array.isArray(obj.appliedHunkIds)
  );
}

/**
 * Normalize a raw persisted message's edit proposals into the ADR-0010 array,
 * accepting either the new `editProposals[]` or the legacy single `editProposal`
 * (older conversations), so a reload never loses an edit review regardless of the
 * format it was saved in.
 */
function migrateEditProposals(message: Record<string, unknown>): EditProposal[] {
  if (Array.isArray(message.editProposals)) {
    return message.editProposals.filter(isValidEditProposal) as EditProposal[];
  }
  return isValidEditProposal(message.editProposal) ? [message.editProposal as EditProposal] : [];
}

/** The applied-edit-record sibling of {@link migrateEditProposals} (new array or legacy single). */
function migrateAppliedEdits(message: Record<string, unknown>): AppliedEditRecord[] {
  if (Array.isArray(message.appliedEdits)) {
    return message.appliedEdits.filter(isValidAppliedEditRecord) as AppliedEditRecord[];
  }
  return isValidAppliedEditRecord(message.appliedEdit) ? [message.appliedEdit as AppliedEditRecord] : [];
}

/**
 * All edit proposals on an in-memory message (ADR-0010), folding the legacy singular
 * field so read sites need one accessor regardless of a message's provenance
 * (migrated on load, or freshly built as an array). Prefer this over touching the
 * fields directly.
 */
export function editProposalsOf(message: ConversationMessage): EditProposal[] {
  if (message.editProposals?.length) return message.editProposals;
  return message.editProposal ? [message.editProposal] : [];
}

/** The applied-edit-record sibling of {@link editProposalsOf}. */
export function appliedEditsOf(message: ConversationMessage): AppliedEditRecord[] {
  if (message.appliedEdits?.length) return message.appliedEdits;
  return message.appliedEdit ? [message.appliedEdit] : [];
}

function isValidVaultOpProposal(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    typeof obj.createdAt === "number" &&
    Array.isArray(obj.ops)
  );
}

function isValidAppliedVaultOpRecord(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.proposalId === "string" && Array.isArray(obj.applied);
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

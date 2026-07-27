import { MAX_CONVERSATIONS } from "../../constants";
import {
  migrateRevisions,
  normalizeInFlightGenerationAudit,
} from "./assistantTurnMigration";
import type {
  ApprovalPosture,
  AgenticStep,
  AssistantMessageRevision,
  Attachment,
  ChatHistory,
  Conversation,
  ConversationMeta,
  ConversationMessage,
  LegacyAssistantRevision,
  MessageVersion,
  MessageUsage,
  ProviderOption,
  RagSourceRef,
} from "../../shared/types";
import type { AppliedEditRecord, EditProposal } from "../../editing/editTypes";
import type { ToolCall } from "../../tools/types";
import { normalizeCompletedAskGuidance } from "../../tools/ask/result";
import { ASK_USER_TOOL_NAME } from "../../tools/ask/definition";
import { generateId } from "../../utils";
import {
  syncAssistantCompatibilityProjection,
} from "./assistantRevisions";
import {
  validateAssistantMessageState,
} from "./assistantMessageValidation";

/** Coerce a raw persisted value to a known posture, defaulting to `ask`. */
export function normalizePosture(raw: unknown): ApprovalPosture {
  return raw === "auto" ? "auto" : "ask";
}

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

/**
 * The label shown for a conversation in the history drawer: its title, or a
 * placeholder when untitled ("New conversation" while empty, "Untitled" once it has
 * messages). Shared so the drawer and history search agree on what a row reads as.
 */
export function conversationDisplayTitle(meta: Pick<ConversationMeta, "title" | "messageCount">): string {
  return meta.title || (meta.messageCount === 0 ? "New conversation" : "Untitled");
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
    approvalPosture: conversation.approvalPosture ?? "ask",
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
    approvalPosture: "ask",
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
    approvalPosture: normalizePosture(raw.approvalPosture),
  };
}

export function normalizeConversation(raw: unknown): Conversation | null {
  // data.json is user-editable and may be corrupt or predate this shape; a non-object
  // (null, a primitive, an array) is not a conversation and is rejected rather than
  // dereferenced into a crash or a junk record.
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const id = typeof record.id === "string" && record.id ? record.id : generateId();
  const title = typeof record.title === "string" ? record.title : "";
  const now = Date.now();
  const createdAt = typeof record.createdAt === "number" ? record.createdAt : now;
  const updatedAt = typeof record.updatedAt === "number" ? record.updatedAt : now;
  const modelId = typeof record.modelId === "string" ? record.modelId : "";
  const modelName = typeof record.modelName === "string" ? record.modelName : "Unknown";
  const draft = typeof record.draft === "string" ? record.draft : "";

  const messages: ConversationMessage[] = [];
  if (Array.isArray(record.messages)) {
    for (const message of record.messages) {
      const normalized = normalizeConversationMessage(message);
      if (normalized) messages.push(normalized);
    }
  }
  const inFlightAudit = normalizeInFlightGenerationAudit(
    record.inFlightGenerationAudit,
  );

  return {
    id,
    title,
    createdAt,
    updatedAt,
    modelId,
    modelName,
    messages,
    draft,
    approvalPosture: normalizePosture(record.approvalPosture),
    // An audit still on disk means the generation that owned it never finished.
    // It is preserved for fail-closed recovery, never silently dropped (ADR-0033).
    ...(inFlightAudit ? { inFlightGenerationAudit: inFlightAudit } : {}),
    ...(typeof record.parentConversationId === "string" &&
    record.parentConversationId
      ? { parentConversationId: record.parentConversationId }
      : {}),
    ...(typeof record.branchFromMessageId === "string" &&
    record.branchFromMessageId
      ? { branchFromMessageId: record.branchFromMessageId }
      : {}),
  };
}

function normalizeConversationMessage(
  value: unknown,
): ConversationMessage | null {
  if (!isRecord(value) || (value.role !== "user" && value.role !== "assistant")) {
    return null;
  }
  if (value.role === "user") return normalizeUserMessage(value);
  return normalizeAssistantMessage(value);
}

function normalizeUserMessage(
  value: Record<string, unknown>,
): ConversationMessage | null {
  if (typeof value.content !== "string") return null;
  const message: ConversationMessage = {
    id: messageIdOf(value),
    role: "user",
    content: value.content,
  };
  const attachments = normalizeAttachments(value.attachments);
  if (attachments.length > 0) message.attachments = attachments;
  return message;
}

function normalizeAssistantMessage(
  value: Record<string, unknown>,
): ConversationMessage | null {
  if (Array.isArray(value.revisions)) {
    const normalized = normalizeNewAssistantMessage(value);
    if (normalized) return normalized;
    if (!hasUsableLegacyAssistantContent(value)) return null;
  }
  return normalizeLegacyAssistantMessage(value);
}

function normalizeNewAssistantMessage(
  value: Record<string, unknown>,
): ConversationMessage | null {
  if (
    !isNonEmptyString(value.id) ||
    !Array.isArray(value.actionLedger)
  ) {
    return null;
  }
  const validation = validateAssistantMessageState({
    revisions: value.revisions,
    activeRevisionId: value.activeRevisionId,
    actionLedger: value.actionLedger,
  });
  if (!validation.ok) return null;
  // Conservative version-1 to version-2 upgrade, in memory only (ADR-0031, ADR-0032).
  // It runs after validation so a corrupt persisted turn is still rejected on
  // its own terms rather than being repaired by the migration.
  const revisions = migrateRevisions(validation.value.revisions);

  return syncAssistantCompatibilityProjection({
    id: value.id,
    role: "assistant",
    content: typeof value.content === "string" ? value.content : "",
    revisions,
    activeRevisionId: validation.value.activeRevisionId,
    actionLedger: validation.value.actionLedger,
  });
}

interface LegacyVersionCandidate {
  rawIndex: number;
  version: MessageVersion;
  revision: LegacyAssistantRevision;
}

function normalizeLegacyAssistantMessage(
  value: Record<string, unknown>,
): ConversationMessage | null {
  if (typeof value.content !== "string") return null;
  const steps = normalizeLegacySteps(value.agenticSteps);
  if (value.content.length === 0 && !steps) return null;

  const messageId = messageIdOf(value);
  const candidates = normalizeLegacyVersions(value.versions, messageId);
  const provenCandidate = findProvenActiveCandidate(
    candidates,
    value.activeVersionIndex,
    value.content,
  );
  const topMetadata = normalizeLegacyTopMetadata(value);
  let revisions: AssistantMessageRevision[] = candidates.map(
    (candidate) => candidate.revision,
  );
  let activeRevisionId: string;

  if (provenCandidate) {
    const activeIndex = candidates.indexOf(provenCandidate);
    revisions[activeIndex] = {
      ...revisions[activeIndex],
      ...topMetadata,
      ...(steps ? { legacySteps: steps } : {}),
    };
    activeRevisionId = revisions[activeIndex].revisionId;
  } else {
    const snapshot: LegacyAssistantRevision = {
      revisionId: legacySnapshotRevisionId(messageId),
      kind: "legacy",
      content: value.content,
      ...topMetadata,
      ...(steps ? { legacySteps: steps } : {}),
    };
    revisions = [...revisions, snapshot];
    activeRevisionId = snapshot.revisionId;
  }

  const validation = validateAssistantMessageState({
    revisions,
    activeRevisionId,
    actionLedger: [],
  });
  if (!validation.ok) {
    const fallback: LegacyAssistantRevision = {
      revisionId: legacySnapshotRevisionId(messageId),
      kind: "legacy",
      content: value.content,
      ...topMetadata,
    };
    const fallbackValidation = validateAssistantMessageState({
      revisions: [fallback],
      activeRevisionId: fallback.revisionId,
      actionLedger: [],
    });
    if (!fallbackValidation.ok) return null;
    revisions = fallbackValidation.value.revisions;
    activeRevisionId = fallbackValidation.value.activeRevisionId;
  } else {
    revisions = validation.value.revisions;
    activeRevisionId = validation.value.activeRevisionId;
  }

  const message = syncAssistantCompatibilityProjection({
    id: messageId,
    role: "assistant",
    content: value.content,
    revisions,
    activeRevisionId,
    actionLedger: [],
  });
  preserveLegacyVersionFields(message, candidates, value.activeVersionIndex);
  preserveLegacyReviewFields(message, value);
  preserveLegacyToolCalls(message, value.toolCalls);
  const active = message.revisions?.find(
    (revision) => revision.revisionId === message.activeRevisionId,
  );
  if (active?.kind === "legacy" && active.legacySteps) {
    message.agenticSteps = structuredClone(active.legacySteps);
  }
  return message;
}

function preserveLegacyToolCalls(
  message: ConversationMessage,
  value: unknown,
): void {
  if (!Array.isArray(value)) return;
  const calls = value.flatMap((candidate): ToolCall[] => {
    if (
      !isRecord(candidate) ||
      !isNonEmptyString(candidate.id) ||
      !isNonEmptyString(candidate.name) ||
      !isRecord(candidate.arguments)
    ) {
      return [];
    }
    return [
      {
        id: candidate.id,
        name: candidate.name,
        arguments: structuredClone(candidate.arguments),
      },
    ];
  });
  if (calls.length > 0) message.toolCalls = calls;
}

function normalizeLegacyVersions(
  value: unknown,
  messageId: string,
): LegacyVersionCandidate[] {
  const rawVersions = asUnknownArray(value);
  if (!rawVersions) return [];
  const candidates: LegacyVersionCandidate[] = [];
  for (let rawIndex = 0; rawIndex < rawVersions.length; rawIndex += 1) {
    const rawVersion = rawVersions[rawIndex];
    if (
      !isRecord(rawVersion) ||
      typeof rawVersion.content !== "string" ||
      !isTimestamp(rawVersion.createdAt)
    ) {
      continue;
    }
    const version: MessageVersion = {
      content: rawVersion.content,
      createdAt: rawVersion.createdAt,
    };
    const usage = normalizeUsage(rawVersion.usage);
    if (usage) version.usage = usage;
    const ragSources = normalizeRagSources(rawVersion.ragSources);
    if (ragSources) version.ragSources = ragSources;
    candidates.push({
      rawIndex,
      version,
      revision: {
        revisionId: legacyVersionRevisionId(messageId, rawIndex),
        kind: "legacy",
        content: version.content,
        createdAt: version.createdAt,
        ...(usage ? { usage } : {}),
        ...(ragSources ? { ragSources } : {}),
      },
    });
  }
  return candidates;
}

function findProvenActiveCandidate(
  candidates: LegacyVersionCandidate[],
  activeVersionIndex: unknown,
  topContent: string,
): LegacyVersionCandidate | null {
  if (!Number.isSafeInteger(activeVersionIndex)) return null;
  const candidate =
    candidates.find(
      (entry) => entry.rawIndex === activeVersionIndex,
    ) ?? null;
  return candidate?.version.content === topContent ? candidate : null;
}

function normalizeLegacyTopMetadata(
  value: Record<string, unknown>,
): Omit<LegacyAssistantRevision, "revisionId" | "kind" | "content"> {
  const metadata: Omit<
    LegacyAssistantRevision,
    "revisionId" | "kind" | "content"
  > = {};
  if (isProvider(value.provider)) metadata.provider = value.provider;
  if (isNonEmptyString(value.modelId)) metadata.modelId = value.modelId;
  const usage = normalizeUsage(value.usage);
  if (usage) metadata.usage = usage;
  const ragSources = normalizeRagSources(value.ragSources);
  if (ragSources) metadata.ragSources = ragSources;
  if (typeof value.rewrittenQuery === "string") {
    metadata.rewrittenQuery = value.rewrittenQuery;
  }
  if (value.isError === true) metadata.isError = true;
  if (value.interrupted === true) metadata.interrupted = true;
  if (typeof value.errorMessage === "string") {
    metadata.errorMessage = value.errorMessage;
  }
  return metadata;
}

function normalizeLegacySteps(value: unknown): AgenticStep[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const steps: AgenticStep[] = [];
  for (const rawStep of value) {
    if (
      !isRecord(rawStep) ||
      (rawStep.type !== "tool_call" && rawStep.type !== "reasoning") ||
      !Number.isSafeInteger(rawStep.round) ||
      (rawStep.round as number) < 0
    ) {
      continue;
    }
    const normalizedStep = { ...rawStep };
    if (Object.prototype.hasOwnProperty.call(normalizedStep, "askGuidance")) {
      const guidance = normalizeCompletedAskGuidance(
        normalizedStep.askGuidance,
      );
      if (guidance) normalizedStep.askGuidance = guidance;
      else delete normalizedStep.askGuidance;
    }
    if (
      normalizedStep.toolName !== ASK_USER_TOOL_NAME ||
      (normalizedStep.askStatus !== "completed" &&
        normalizedStep.askStatus !== "cancelled" &&
        normalizedStep.askStatus !== "skipped")
    ) {
      delete normalizedStep.askStatus;
    }
    steps.push(normalizedStep as unknown as AgenticStep);
  }
  return steps.length > 0 ? steps : undefined;
}

function preserveLegacyVersionFields(
  message: ConversationMessage,
  candidates: LegacyVersionCandidate[],
  activeVersionIndex: unknown,
): void {
  if (candidates.length === 0) return;
  message.versions = candidates.map((candidate) =>
    structuredClone(candidate.version),
  );
  const mappedActiveIndex = Number.isSafeInteger(activeVersionIndex)
    ? candidates.findIndex(
        (candidate) => candidate.rawIndex === activeVersionIndex,
      )
    : -1;
  message.activeVersionIndex =
    mappedActiveIndex >= 0 ? mappedActiveIndex : candidates.length - 1;
}

function preserveLegacyReviewFields(
  message: ConversationMessage,
  value: Record<string, unknown>,
): void {
  const editProposals = migrateEditProposals(value);
  if (editProposals.length > 0) {
    message.editProposals = structuredClone(editProposals);
  }
  const appliedEdits = migrateAppliedEdits(value);
  if (appliedEdits.length > 0) {
    message.appliedEdits = structuredClone(appliedEdits);
  }
  if (isValidVaultOpProposal(value.vaultOpProposal)) {
    message.vaultOpProposal = structuredClone(
      value.vaultOpProposal as NonNullable<
        ConversationMessage["vaultOpProposal"]
      >,
    );
  }
  if (isValidAppliedVaultOpRecord(value.appliedVaultOps)) {
    message.appliedVaultOps = structuredClone(
      value.appliedVaultOps as NonNullable<
        ConversationMessage["appliedVaultOps"]
      >,
    );
  }
}

function normalizeUsage(value: unknown): MessageUsage | undefined {
  if (
    !isRecord(value) ||
    typeof value.inputTokens !== "number" ||
    !Number.isFinite(value.inputTokens) ||
    typeof value.outputTokens !== "number" ||
    !Number.isFinite(value.outputTokens)
  ) {
    return undefined;
  }
  return structuredClone(value) as unknown as MessageUsage;
}

function normalizeRagSources(value: unknown): RagSourceRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sources = value.filter(
    (source): source is RagSourceRef =>
      isRecord(source) &&
      typeof source.filePath === "string" &&
      typeof source.headingPath === "string" &&
      typeof source.score === "number" &&
      Number.isFinite(source.score),
  );
  return sources.length > 0 ? structuredClone(sources) : undefined;
}

function normalizeAttachments(value: unknown): Attachment[] {
  return Array.isArray(value)
    ? (value as unknown[]).filter(isValidAttachment)
    : [];
}

function hasUsableLegacyAssistantContent(
  value: Record<string, unknown>,
): boolean {
  return (
    (typeof value.content === "string" && value.content.length > 0) ||
    normalizeLegacySteps(value.agenticSteps) !== undefined
  );
}

function messageIdOf(value: Record<string, unknown>): string {
  return isNonEmptyString(value.id) ? value.id : generateId();
}

function legacyVersionRevisionId(
  messageId: string,
  rawIndex: number,
): string {
  return `${messageId}:legacy-version:${rawIndex}`;
}

function legacySnapshotRevisionId(messageId: string): string {
  return `${messageId}:legacy-snapshot`;
}

function isProvider(value: unknown): value is ProviderOption {
  return (
    value === "lmstudio" ||
    value === "openai" ||
    value === "anthropic" ||
    value === "claudecode"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asUnknownArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? (value as unknown[]) : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
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
  // A branch forks the same session, so it inherits the source's posture rather
  // than resetting to the new-conversation default.
  branch.approvalPosture = source.approvalPosture ?? "ask";
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
 * All edit proposals on an in-memory message (ADR-0010). An in-memory message is
 * always plural: the load-time migration ({@link migrateEditProposals}) folds any
 * legacy pre-ADR-0010 singular field into the array at the persistence boundary, and
 * new code only ever writes the array (the singular field was retired from the type,
 * ADR-0027). Kept as the canonical accessor so read sites need not repeat the guard.
 */
export function editProposalsOf(message: ConversationMessage): EditProposal[] {
  return message.editProposals ?? [];
}

/** The applied-edit-record sibling of {@link editProposalsOf}. */
export function appliedEditsOf(message: ConversationMessage): AppliedEditRecord[] {
  return message.appliedEdits ?? [];
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

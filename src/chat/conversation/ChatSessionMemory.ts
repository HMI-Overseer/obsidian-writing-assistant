import type {
  AssistantMessageRevision,
  ClaudeCodeResumeCursor,
  Conversation,
  ConversationMeta,
  ConversationMessage,
  RagSourceRef,
  ToolActionEvent,
  ToolActionLedgerEntry,
} from "../../shared/types";
import { generateId } from "../../utils";
import type { ChatSessionSnapshot } from "../types";
import {
  appendAssistantRevision,
  assistantDisplayText,
  createEditedRevision,
  getActiveAssistantRevision,
  selectAssistantRevision,
  syncAssistantCompatibilityProjection,
} from "./assistantRevisions";
import {
  appendActionEvent,
  deriveActionControlEligibility,
  supersedeUnresolvedActions,
  type ActionControlEligibility,
  type SupersessionEventIdentity,
} from "./actionLedger";

/**
 * Pure in-memory conversation state, no async, no disk I/O, no plugin dependency.
 *
 * This class is trivially testable: construct it, call methods, assert state.
 * The ChatSessionStore coordinates this with persistence.
 */
export class ChatSessionMemory {
  private activeConversationId: string | null = null;
  private messageHistory: ConversationMessage[] = [];
  private lastAssistantResponse = "";
  private draft = "";

  private activeModelId = "";
  private activeModelName = "";
  private activeCreatedAt = 0;
  private activeParentConversationId: string | undefined;
  private activeBranchFromMessageId: string | undefined;
  private inheritedBranchRevisionIds = new Set<string>();

  getSnapshot(): ChatSessionSnapshot {
    return {
      activeConversationId: this.activeConversationId,
      draft: this.draft,
      messageHistory: [...this.messageHistory],
      lastAssistantResponse: this.lastAssistantResponse,
    };
  }

  getActiveConversationId(): string | null {
    return this.activeConversationId;
  }

  getActiveModelId(): string {
    return this.activeModelId;
  }

  getActiveModelName(): string {
    return this.activeModelName;
  }

  getActiveCreatedAt(): number {
    return this.activeCreatedAt;
  }

  getActiveBranchOrigin(): Pick<
    Conversation,
    "parentConversationId" | "branchFromMessageId"
  > {
    return {
      ...(this.activeParentConversationId === undefined
        ? {}
        : {
            parentConversationId:
              this.activeParentConversationId,
          }),
      ...(this.activeBranchFromMessageId === undefined
        ? {}
        : {
            branchFromMessageId:
              this.activeBranchFromMessageId,
          }),
    };
  }

  /**
   * The conversation's current Claude Code resume cursor (Model A′): the cursor
   * banked by the most recent claudecode assistant turn that carries one. Read at the
   * start of a turn so the session registry can `resume` from disk once the live
   * process is gone. Undefined when no claudecode turn has banked a cursor yet (a
   * fresh conversation, an older transcript, or a non-claudecode thread).
   */
  getClaudeCodeResumeCursor(): ClaudeCodeResumeCursor | undefined {
    const latestEditAt = this.messageHistory.reduce((latest, message) => {
      const revision = getActiveAssistantRevision(message);
      if (
        revision?.kind !== "turn" ||
        revision.origin !== "edited"
      ) {
        return latest;
      }
      return Math.max(latest, revision.createdAt);
    }, -1);
    for (let i = this.messageHistory.length - 1; i >= 0; i--) {
      const message = this.messageHistory[i];
      const activeRevision = getActiveAssistantRevision(message);
      if (
        message.role === "assistant" &&
        (activeRevision?.provider ?? message.provider) === "claudecode" &&
        (activeRevision?.usage ?? message.usage)?.resumeCursor &&
        (latestEditAt < 0 ||
          (activeRevision?.createdAt ?? -1) > latestEditAt)
      ) {
        return (activeRevision?.usage ?? message.usage)?.resumeCursor;
      }
    }
    return undefined;
  }

  setDraft(draft: string): void {
    this.draft = draft;
  }

  setActiveModel(id: string, name: string): void {
    this.activeModelId = id;
    this.activeModelName = name;
  }

  appendMessage(message: ConversationMessage): void {
    this.messageHistory.push(
      message.role === "assistant" && message.revisions
        ? syncAssistantCompatibilityProjection(message)
        : message,
    );
  }

  setLastAssistantResponse(text: string): void {
    this.lastAssistantResponse = text;
  }

  updateMessageContent(messageId: string, newContent: string): boolean {
    const index = this.messageHistory.findIndex((message) => message.id === messageId);
    if (index === -1) return false;
    const message = this.messageHistory[index];
    if (message.role !== "assistant") {
      this.messageHistory[index] = { ...message, content: newContent };
      return true;
    }

    const revisionBacked = ensureRevisionBackedMessage(message);
    const active = getActiveAssistantRevision(revisionBacked);
    if (!active) return false;
    let revision: AssistantMessageRevision;
    if (active.kind === "legacy") {
      revision = {
        ...structuredClone(active),
        revisionId: generateId(),
        createdAt: Date.now(),
        content: newContent,
        legacySteps: undefined,
      };
    } else {
      const proseItems = active.turn.items.filter(
        (item) => item.type === "prose",
      );
      if (proseItems.length !== 1) return false;
      return this.editAssistantProseItem(
        messageId,
        proseItems[0].id,
        newContent,
      );
    }
    this.messageHistory[index] = appendAssistantRevision(
      revisionBacked,
      revision,
    );
    this.recalcLastAssistantResponse();
    return true;
  }

  removeMessage(messageId: string): ConversationMessage | null {
    const index = this.messageHistory.findIndex((m) => m.id === messageId);
    if (index === -1) return null;

    const [removed] = this.messageHistory.splice(index, 1);
    this.recalcLastAssistantResponse();
    return removed;
  }

  removeLastMessage(): ConversationMessage | null {
    if (this.messageHistory.length === 0) return null;

    const removed = this.messageHistory.pop();
    if (!removed) return null;

    this.recalcLastAssistantResponse();
    return removed;
  }

  getMessagesUpToInclusive(messageId: string): ConversationMessage[] {
    const index = this.messageHistory.findIndex((m) => m.id === messageId);
    if (index === -1) return [];

    return structuredClone(this.messageHistory.slice(0, index + 1));
  }

  finalizeRegeneration(
    oldMessage: ConversationMessage,
    newContent: string,
    metadata?: Pick<
      ConversationMessage,
      | "modelId"
      | "provider"
      | "usage"
      | "ragSources"
      | "rewrittenQuery"
      | "agenticSteps"
      | "interrupted"
    >,
  ): ConversationMessage {
    const now = Date.now();
    const revisionBacked = ensureRevisionBackedMessage(oldMessage);
    const replacedRevisionId = revisionBacked.activeRevisionId;
    const revision: AssistantMessageRevision = {
      revisionId: generateId(),
      kind: "legacy",
      content: newContent,
      createdAt: now,
      ...(metadata?.provider === undefined
        ? {}
        : { provider: metadata.provider }),
      ...(metadata?.modelId === undefined
        ? {}
        : { modelId: metadata.modelId }),
      ...(metadata?.usage === undefined
        ? {}
        : { usage: structuredClone(metadata.usage) }),
      ...(metadata?.ragSources === undefined
        ? {}
        : { ragSources: structuredClone(metadata.ragSources) }),
      ...(metadata?.rewrittenQuery === undefined
        ? {}
        : { rewrittenQuery: metadata.rewrittenQuery }),
      ...(metadata?.interrupted === undefined
        ? {}
        : { interrupted: metadata.interrupted }),
      ...(metadata?.agenticSteps === undefined
        ? {}
        : { legacySteps: structuredClone(metadata.agenticSteps) }),
    };
    let newMessage = appendAssistantRevision(revisionBacked, revision);
    if (replacedRevisionId && newMessage.actionLedger) {
      newMessage = {
        ...newMessage,
        actionLedger: supersedeUnresolvedActions(
          newMessage.actionLedger,
          replacedRevisionId,
          revision.revisionId,
          (_actionRef, _targetId, index) => ({
            eventId: generateId(),
            createdAt: now + index,
          }),
        ),
      };
    }
    this.messageHistory.push(newMessage);
    this.lastAssistantResponse = assistantDisplayText(newMessage);
    return newMessage;
  }

  /**
   * Put a message that {@link removeLastMessage} popped for a regeneration back
   * onto the history unchanged. Used when a regeneration is aborted before any
   * text streams: the original content and its full version history must survive
   * exactly. Unlike {@link finalizeRegeneration} (which always appends the new
   * content as a fresh version), this records no spurious duplicate version, a
   * stopped attempt produced nothing to version.
   */
  restoreRegeneration(oldMessage: ConversationMessage): void {
    this.messageHistory.push(oldMessage);
    this.recalcLastAssistantResponse();
  }

  switchMessageRevision(messageId: string, revisionId: string): boolean {
    const index = this.messageHistory.findIndex((message) => message.id === messageId);
    if (index === -1) return false;
    const selected = selectAssistantRevision(
      ensureRevisionBackedMessage(this.messageHistory[index]),
      revisionId,
    );
    if (!selected) return false;
    this.messageHistory[index] = selected;
    this.recalcLastAssistantResponse();
    return true;
  }

  editAssistantProseItem(
    messageId: string,
    proseItemId: string,
    text: string,
  ): boolean {
    const message = this.messageHistory.find((entry) => entry.id === messageId);
    if (!message || message.role !== "assistant") return false;
    const current = ensureRevisionBackedMessage(message);
    const source = getActiveAssistantRevision(current);
    if (source?.kind !== "turn") return false;
    const target = source.turn.items.find((item) => item.id === proseItemId);
    if (target?.type !== "prose" || text.length === 0) return false;

    const createdAt = Date.now();
    const revision = createEditedRevision({
      sourceRevision: source,
      revisionId: generateId(),
      turnId: generateId(),
      createdAt,
      targetProseItemId: proseItemId,
      text,
      itemId: () => generateId(),
    });
    const supersessionCreatedAt = Math.max(
      createdAt,
      ...(current.actionLedger ?? []).flatMap((entry) =>
        entry.events.map((event) => event.createdAt),
      ),
    );
    return this.commitRevisionReplacement(
      messageId,
      revision,
      (_actionRef, _targetId, eventIndex) => ({
        eventId: generateId(),
        createdAt: supersessionCreatedAt + eventIndex,
      }),
    );
  }

  getActionControlEligibility(
    messageId: string,
    actionRef: string,
    targetId: string,
    driftGuardAllowsUndo = true,
  ): ActionControlEligibility {
    const messageIndex = this.messageHistory.findIndex(
      (message) => message.id === messageId,
    );
    const unavailable: ActionControlEligibility = {
      canApprove: false,
      canDecline: false,
      canApply: false,
      canRetry: false,
      canUndo: false,
    };
    if (messageIndex === -1) return unavailable;
    const message = this.messageHistory[messageIndex];
    const revision = getActiveAssistantRevision(message);
    const entry = message.actionLedger?.find(
      (candidate) => candidate.actionRef === actionRef,
    );
    if (!revision || !entry) return unavailable;

    return deriveActionControlEligibility(entry, targetId, {
      activeRevisionId: revision.revisionId,
      isActiveConversationHead:
        messageIndex === this.messageHistory.length - 1 &&
        !this.inheritedBranchRevisionIds.has(entry.revisionId),
      visibleRevisionReferencesAction:
        revision.kind === "turn" &&
        revision.turn.items.some((item) => item.actionRef === actionRef),
      driftGuardAllowsUndo,
    });
  }

  appendEligibleActionEvent(
    messageId: string,
    actionRef: string,
    event: ToolActionEvent,
    driftGuardAllowsUndo = true,
  ): boolean {
    const messageIndex = this.messageHistory.findIndex(
      (message) => message.id === messageId,
    );
    if (messageIndex === -1) return false;
    const message = this.messageHistory[messageIndex];
    const entryIndex =
      message.actionLedger?.findIndex(
        (entry) => entry.actionRef === actionRef,
      ) ?? -1;
    if (entryIndex === -1 || !message.actionLedger) return false;
    const entry = message.actionLedger[entryIndex];
    const duplicate = entry.events.find(
      (candidate) => candidate.eventId === event.eventId,
    );
    if (duplicate) {
      return appendActionEvent(entry, event) === entry;
    }

    const eligibility = this.getActionControlEligibility(
      messageId,
      actionRef,
      event.targetId,
      driftGuardAllowsUndo,
    );
    if (!eventIsEligible(event, eligibility)) return false;

    const actionLedger = [...message.actionLedger];
    actionLedger[entryIndex] = appendActionEvent(entry, event);
    this.messageHistory[messageIndex] = {
      ...message,
      actionLedger,
    };
    return true;
  }

  /**
   * Deprecated index adapter for Phase 2 callers. Revision identity remains the
   * mutation seam and legacy version fields are not rewritten.
   */
  switchMessageVersion(messageId: string, newIndex: number): boolean {
    const message = this.messageHistory.find((entry) => entry.id === messageId);
    if (!message) return false;
    const revisionBacked = ensureRevisionBackedMessage(message);
    const revision = revisionBacked.revisions?.[newIndex];
    if (!revision) return false;
    const switched = this.switchMessageRevision(messageId, revision.revisionId);
    if (switched && this.messageHistory.find((entry) => entry.id === messageId)?.versions) {
      const selected = this.messageHistory.find((entry) => entry.id === messageId);
      if (selected) selected.activeVersionIndex = newIndex;
    }
    return switched;
  }

  commitRevisionReplacement(
    messageId: string,
    revision: AssistantMessageRevision,
    identity: (
      actionRef: string,
      targetId: string,
      index: number,
    ) => SupersessionEventIdentity,
    newActionLedger: ToolActionLedgerEntry[] = [],
  ): boolean {
    const index = this.messageHistory.findIndex((message) => message.id === messageId);
    if (index === -1) return false;
    const current = ensureRevisionBackedMessage(this.messageHistory[index]);
    const replacedRevisionId = current.activeRevisionId;
    if (!replacedRevisionId) return false;
    const appended = appendAssistantRevision(current, revision);
    const withNewActions = {
      ...appended,
      actionLedger: [
        ...(appended.actionLedger ?? []),
        ...structuredClone(newActionLedger),
      ],
    };
    this.messageHistory[index] = {
      ...withNewActions,
      actionLedger: supersedeUnresolvedActions(
        withNewActions.actionLedger,
        replacedRevisionId,
        revision.revisionId,
        identity,
      ),
    };
    this.recalcLastAssistantResponse();
    return true;
  }

  /**
   * Replace all in-memory state from a loaded or newly created conversation.
   * This is the single mutation point for "conversation switched."
   */
  hydrateFromConversation(conversation: Conversation): void {
    this.activeConversationId = conversation.id;
    this.messageHistory = conversation.messages.map((message) =>
      message.role === "assistant" && message.revisions
        ? syncAssistantCompatibilityProjection(message)
        : message,
    );
    this.lastAssistantResponse =
      assistantDisplayText(
        [...this.messageHistory]
          .reverse()
          .find((message) => message.role === "assistant") ?? {
          id: "",
          role: "assistant",
          content: "",
        },
      );
    this.draft = conversation.draft;
    this.activeModelId = conversation.modelId;
    this.activeModelName = conversation.modelName;
    this.activeCreatedAt = conversation.createdAt;
    this.activeParentConversationId = conversation.parentConversationId;
    this.activeBranchFromMessageId = conversation.branchFromMessageId;
    this.inheritedBranchRevisionIds =
      collectInheritedBranchRevisionIds(conversation);
  }

  /**
   * Build a full Conversation object from current in-memory state + metadata.
   * Returns null if no active conversation.
   */
  buildActiveConversation(meta: ConversationMeta | null): Conversation | null {
    const id = this.activeConversationId;
    if (!id || !meta) return null;

    return {
      id,
      title: meta.title,
      createdAt: this.activeCreatedAt || meta.createdAt,
      updatedAt: meta.updatedAt,
      modelId: meta.modelId,
      modelName: meta.modelName,
      messages: [...this.messageHistory],
      draft: this.draft,
      approvalPosture: meta.approvalPosture ?? "ask",
      ...this.getActiveBranchOrigin(),
    };
  }

  /**
   * Build a clean messages array for persistence (error messages stripped, RAG chunk content stripped).
   */
  getCleanMessagesForPersistence(): ConversationMessage[] {
    return this.messageHistory
      .map((message) =>
        message.role === "assistant" && message.revisions
          ? syncAssistantCompatibilityProjection(message)
          : message,
      )
      .filter((message) => !message.isError)
      .map(stripRagChunkContent);
  }

  private recalcLastAssistantResponse(): void {
    const lastAssistant = [...this.messageHistory].reverse().find((m) => m.role === "assistant");
    this.lastAssistantResponse = lastAssistant
      ? assistantDisplayText(lastAssistant)
      : "";
  }
}

function collectInheritedBranchRevisionIds(
  conversation: Conversation,
): Set<string> {
  if (
    !conversation.parentConversationId ||
    !conversation.branchFromMessageId
  ) {
    return new Set();
  }
  const cutoffIndex = conversation.messages.findIndex(
    (message) => message.id === conversation.branchFromMessageId,
  );
  if (cutoffIndex === -1) return new Set();
  const inherited = new Set<string>();
  for (const message of conversation.messages.slice(0, cutoffIndex + 1)) {
    for (const revision of message.revisions ?? []) {
      if (
        revision.createdAt === undefined ||
        revision.createdAt <= conversation.createdAt
      ) {
        inherited.add(revision.revisionId);
      }
    }
  }
  return inherited;
}

function eventIsEligible(
  event: ToolActionEvent,
  eligibility: ActionControlEligibility,
): boolean {
  switch (event.type) {
    case "approved":
      return eligibility.canApprove;
    case "declined":
      return eligibility.canDecline;
    case "apply_succeeded":
    case "apply_failed":
      return eligibility.canApply;
    case "retry_requested":
      return eligibility.canRetry;
    case "undo_succeeded":
    case "undo_refused":
      return eligibility.canUndo;
    case "proposed":
    case "superseded":
      return false;
  }
}

/** Strip chunk text content from RAG sources to keep persisted data lean. */
function stripRagSources(sources?: RagSourceRef[]): RagSourceRef[] | undefined {
  if (!sources) return undefined;
  return sources.map(({ filePath, headingPath, score }) => ({ filePath, headingPath, score }));
}

/** Return a shallow copy of the message with chunk content stripped from ragSources (top-level and per-version). */
function stripRagChunkContent(message: ConversationMessage): ConversationMessage {
  if (
    !message.ragSources &&
    !message.versions?.some((version) => version.ragSources) &&
    !message.revisions?.some((revision) => revision.ragSources)
  ) {
    return message;
  }
  return {
    ...message,
    ragSources: stripRagSources(message.ragSources),
    versions: message.versions?.map((version) =>
      version.ragSources
        ? { ...version, ragSources: stripRagSources(version.ragSources) }
        : version,
    ),
    revisions: message.revisions?.map((revision) =>
      revision.ragSources
        ? { ...revision, ragSources: stripRagSources(revision.ragSources) }
        : revision,
    ),
  };
}

function ensureRevisionBackedMessage(
  message: ConversationMessage,
): ConversationMessage {
  if (message.role !== "assistant" || message.revisions?.length) {
    return message;
  }
  const versions = message.versions ?? [];
  const revisions: AssistantMessageRevision[] =
    versions.length > 0
      ? versions.map((version, index) => ({
          revisionId: `${message.id}:compat-version:${index}`,
          kind: "legacy",
          content: version.content,
          createdAt: version.createdAt,
          ...(version.usage === undefined
            ? {}
            : { usage: structuredClone(version.usage) }),
          ...(version.ragSources === undefined
            ? {}
            : { ragSources: structuredClone(version.ragSources) }),
        }))
      : [
          {
            revisionId: `${message.id}:compat-snapshot`,
            kind: "legacy",
            content: message.content,
            ...(message.agenticSteps === undefined
              ? {}
              : { legacySteps: structuredClone(message.agenticSteps) }),
          },
        ];
  const activeIndex =
    versions.length > 0
      ? Math.min(
          Math.max(message.activeVersionIndex ?? versions.length - 1, 0),
          versions.length - 1,
        )
      : 0;
  revisions[activeIndex] = {
    ...revisions[activeIndex],
    ...(message.provider === undefined ? {} : { provider: message.provider }),
    ...(message.modelId === undefined ? {} : { modelId: message.modelId }),
    ...(message.usage === undefined
      ? {}
      : { usage: structuredClone(message.usage) }),
    ...(message.ragSources === undefined
      ? {}
      : { ragSources: structuredClone(message.ragSources) }),
    ...(message.rewrittenQuery === undefined
      ? {}
      : { rewrittenQuery: message.rewrittenQuery }),
    ...(message.isError === undefined ? {} : { isError: message.isError }),
    ...(message.interrupted === undefined
      ? {}
      : { interrupted: message.interrupted }),
    ...(message.agenticSteps === undefined
      ? {}
      : { legacySteps: structuredClone(message.agenticSteps) }),
  };
  return syncAssistantCompatibilityProjection({
    ...message,
    revisions,
    activeRevisionId: revisions[activeIndex].revisionId,
    actionLedger: message.actionLedger ?? [],
  });
}

import type {
  AssistantMessageRevision,
  ClaudeCodeResumeCursor,
  Conversation,
  ConversationMeta,
  ConversationMessage,
  ProviderOption,
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
import type { ProseItemEdit } from "./assistantRevisions";
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
        activeRevision?.provider === "claudecode" &&
        activeRevision.usage?.resumeCursor &&
        (latestEditAt < 0 ||
          (activeRevision.createdAt ?? -1) > latestEditAt)
      ) {
        return activeRevision.usage.resumeCursor;
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
    if (message.role === "assistant" && !message.revisions?.length) {
      throw new Error("Assistant messages must carry an immutable revision.");
    }
    this.messageHistory.push(
      message.role === "assistant" && message.revisions
        ? syncAssistantCompatibilityProjection(message)
        : message,
    );
  }

  setLastAssistantResponse(text: string): void {
    this.lastAssistantResponse = text;
  }

  updateUserMessageContent(messageId: string, newContent: string): boolean {
    const index = this.messageHistory.findIndex((message) => message.id === messageId);
    if (index === -1) return false;
    const message = this.messageHistory[index];
    if (message.role !== "user") return false;
    this.messageHistory[index] = { ...message, content: newContent };
    return true;
  }

  editLegacyAssistantContent(
    messageId: string,
    text: string,
    provider: ProviderOption,
    modelId: string,
  ): boolean {
    const message = this.messageHistory.find(
      (entry) => entry.id === messageId,
    );
    if (
      !message ||
      message.role !== "assistant" ||
      !message.revisions?.length
    ) {
      return false;
    }
    const source = getActiveAssistantRevision(message);
    if (source?.kind !== "legacy") return false;

    const createdAt = Date.now();
    const segmentId = generateId();
    const revision: AssistantMessageRevision = {
      revisionId: generateId(),
      kind: "turn",
      origin: "edited",
      parentRevisionId: source.revisionId,
      createdAt,
      provider,
      modelId,
      turn: {
        schemaVersion: 1,
        id: generateId(),
        status: "completed",
        segments: text.length > 0 ? [{ id: segmentId }] : [],
        items:
          text.length > 0
            ? [
                {
                  type: "prose",
                  id: generateId(),
                  segmentId,
                  text,
                },
              ]
            : [],
      },
    };
    const supersessionCreatedAt = Math.max(
      createdAt,
      ...(message.actionLedger ?? []).flatMap((entry) =>
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

  switchMessageRevision(messageId: string, revisionId: string): boolean {
    const index = this.messageHistory.findIndex((message) => message.id === messageId);
    if (index === -1) return false;
    const selected = selectAssistantRevision(
      this.messageHistory[index],
      revisionId,
    );
    if (!selected) return false;
    this.messageHistory[index] = selected;
    this.recalcLastAssistantResponse();
    return true;
  }

  /** Commit one edit session over the active turn as a single edited revision. */
  editAssistantTurnProse(
    messageId: string,
    edits: readonly ProseItemEdit[],
  ): boolean {
    const message = this.messageHistory.find((entry) => entry.id === messageId);
    if (!message || message.role !== "assistant") return false;
    const source = getActiveAssistantRevision(message);
    if (source?.kind !== "turn" || edits.length === 0) return false;
    const targetable = edits.every((edit) => {
      const target = source.turn.items.find(
        (item) => item.id === edit.sourceProseItemId,
      );
      return target?.type === "prose" && edit.text.length > 0;
    });
    if (!targetable) return false;

    const createdAt = Date.now();
    const revision = createEditedRevision({
      sourceRevision: source,
      revisionId: generateId(),
      turnId: generateId(),
      createdAt,
      edits,
      itemId: () => generateId(),
    });
    const supersessionCreatedAt = Math.max(
      createdAt,
      ...(message.actionLedger ?? []).flatMap((entry) =>
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
    const current = this.messageHistory[index];
    const replacedRevisionId = current.activeRevisionId;
    if (
      current.role !== "assistant" ||
      !current.revisions?.length ||
      !replacedRevisionId
    ) {
      return false;
    }
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
    // Write-ahead audit evidence (`intent_recorded`, `outcome_unknown`) is
    // history, never an actionable control: both describe work that already
    // left the plugin's hands (RFC-0011).
    case "proposed":
    case "superseded":
    case "intent_recorded":
    case "outcome_unknown":
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

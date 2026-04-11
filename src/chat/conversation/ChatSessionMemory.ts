import type {
  Conversation,
  ConversationMeta,
  ConversationMessage,
  MessageVersion,
  RagSourceRef,
} from "../../shared/types";
import type { ChatSessionSnapshot } from "../types";

/**
 * Pure in-memory conversation state — no async, no disk I/O, no plugin dependency.
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

  setDraft(draft: string): void {
    this.draft = draft;
  }

  setActiveModel(id: string, name: string): void {
    this.activeModelId = id;
    this.activeModelName = name;
  }

  appendMessage(message: ConversationMessage): void {
    this.messageHistory.push(message);
  }

  setLastAssistantResponse(text: string): void {
    this.lastAssistantResponse = text;
  }

  updateMessageContent(messageId: string, newContent: string): boolean {
    const message = this.messageHistory.find((m) => m.id === messageId);
    if (!message) return false;

    message.content = newContent;
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

    return this.messageHistory.slice(0, index + 1);
  }

  finalizeRegeneration(
    oldMessage: ConversationMessage,
    newContent: string,
    metadata?: Pick<ConversationMessage, "modelId" | "provider" | "usage" | "ragSources" | "rewrittenQuery" | "agenticSteps">,
  ): ConversationMessage {
    const now = Date.now();

    let versions: MessageVersion[];
    if (oldMessage.versions && oldMessage.versions.length > 0) {
      versions = [...oldMessage.versions];
    } else {
      versions = [{ content: oldMessage.content, createdAt: now, usage: oldMessage.usage, ragSources: oldMessage.ragSources }];
    }
    versions.push({ content: newContent, createdAt: now, usage: metadata?.usage, ragSources: metadata?.ragSources });

    const newMessage: ConversationMessage = {
      id: oldMessage.id,
      role: "assistant",
      content: newContent,
      versions,
      activeVersionIndex: versions.length - 1,
      ...metadata,
    };

    this.messageHistory.push(newMessage);
    this.lastAssistantResponse = newContent;
    return newMessage;
  }

  switchMessageVersion(messageId: string, newIndex: number): boolean {
    const message = this.messageHistory.find((m) => m.id === messageId);
    if (!message || !message.versions) return false;
    if (newIndex < 0 || newIndex >= message.versions.length) return false;

    message.content = message.versions[newIndex].content;
    message.ragSources = message.versions[newIndex].ragSources;
    message.activeVersionIndex = newIndex;

    if (message.role === "assistant") {
      const lastAssistant = [...this.messageHistory].reverse().find((m) => m.role === "assistant");
      if (lastAssistant?.id === messageId) {
        this.lastAssistantResponse = message.content;
      }
    }

    return true;
  }

  /**
   * Replace all in-memory state from a loaded or newly created conversation.
   * This is the single mutation point for "conversation switched."
   */
  hydrateFromConversation(conversation: Conversation): void {
    this.activeConversationId = conversation.id;
    this.messageHistory = [...conversation.messages];
    this.lastAssistantResponse =
      [...conversation.messages].reverse().find((message) => message.role === "assistant")
        ?.content ?? "";
    this.draft = conversation.draft;
    this.activeModelId = conversation.modelId;
    this.activeModelName = conversation.modelName;
    this.activeCreatedAt = conversation.createdAt;
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
    };
  }

  /**
   * Build a clean messages array for persistence (error messages stripped, RAG chunk content stripped).
   */
  getCleanMessagesForPersistence(): ConversationMessage[] {
    return this.messageHistory.filter((m) => !m.isError).map(stripRagChunkContent);
  }

  private recalcLastAssistantResponse(): void {
    const lastAssistant = [...this.messageHistory].reverse().find((m) => m.role === "assistant");
    this.lastAssistantResponse = lastAssistant?.content ?? "";
  }
}

/** Strip chunk text content from RAG sources to keep persisted data lean. */
function stripRagSources(sources?: RagSourceRef[]): RagSourceRef[] | undefined {
  if (!sources) return undefined;
  return sources.map(({ filePath, headingPath, score }) => ({ filePath, headingPath, score }));
}

/** Return a shallow copy of the message with chunk content stripped from ragSources (top-level and per-version). */
function stripRagChunkContent(message: ConversationMessage): ConversationMessage {
  if (!message.ragSources && !message.versions?.some((v) => v.ragSources)) return message;
  return {
    ...message,
    ragSources: stripRagSources(message.ragSources),
    versions: message.versions?.map((v) =>
      v.ragSources ? { ...v, ragSources: stripRagSources(v.ragSources) } : v,
    ),
  };
}

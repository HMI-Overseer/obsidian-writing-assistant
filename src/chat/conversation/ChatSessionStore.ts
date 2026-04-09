import type {
  CompletionModel,
  Conversation,
  ConversationMeta,
  ConversationMessage,
  MessageVersion,
  RagSourceRef,
} from "../../shared/types";
import type LMStudioWritingAssistant from "../../main";
import { resolveCompletionModel } from "../../utils";
import {
  createConversation,
  generateConversationTitle,
  pruneHistory,
  toConversationMeta,
} from "./conversationUtils";
import type { ConversationStorage } from "./ConversationStorage";
import type { ChatSessionSnapshot } from "../types";

const CHAT_DRAFT_SAVE_DELAY_MS = 300;

export class ChatSessionStore {
  private activeConversationId: string | null = null;
  private messageHistory: ConversationMessage[] = [];
  private lastAssistantResponse = "";
  private draft = "";
  private draftSaveTimer: number | null = null;

  /** Metadata fields for the active conversation that don't live in messageHistory. */
  private activeModelId = "";
  private activeModelName = "";
  private activeCreatedAt = 0;

  constructor(
    private readonly plugin: LMStudioWritingAssistant,
    private readonly storage: ConversationStorage,
  ) {}

  getSnapshot(): ChatSessionSnapshot {
    return {
      activeConversationId: this.activeConversationId,
      draft: this.draft,
      messageHistory: [...this.messageHistory],
      lastAssistantResponse: this.lastAssistantResponse,
    };
  }

  getConversations(): ConversationMeta[] {
    return this.plugin.settings.chatHistory.conversations;
  }

  getActiveConversationId(): string | null {
    return this.activeConversationId;
  }

  getActiveConversationMeta(): ConversationMeta | null {
    return this.findMeta(this.activeConversationId);
  }

  /** Build a full Conversation object from the current in-memory state. */
  private buildActiveConversation(): Conversation | null {
    const id = this.activeConversationId;
    if (!id) return null;

    const meta = this.findMeta(id);
    if (!meta) return null;

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

  getResolvedConversationModel(
    meta: ConversationMeta | null = this.findMeta(this.activeConversationId),
  ): CompletionModel | null {
    return meta ? resolveCompletionModel(this.plugin.settings, meta.modelId) : null;
  }

  setDraft(draft: string): void {
    this.draft = draft;
  }

  appendMessage(message: ConversationMessage): void {
    this.messageHistory.push(message);
  }

  setLastAssistantResponse(text: string): void {
    this.lastAssistantResponse = text;
  }

  ensureConversationTitleFromFirstUserMessage(text: string): boolean {
    if (this.messageHistory.length > 0) return false;

    const meta = this.findMeta(this.activeConversationId);
    if (!meta || meta.title) return false;

    meta.title = generateConversationTitle(text);
    return true;
  }

  async restorePersistedState(): Promise<void> {
    const history = this.plugin.settings.chatHistory;
    const currentId = history.activeConversationId;

    if (currentId) {
      const conversation = await this.storage.load(currentId);
      if (conversation) {
        this.hydrateFromConversation(conversation);
        return;
      }
    }

    if (history.conversations.length > 0) {
      const firstId = history.conversations[0].id;
      const conversation = await this.storage.load(firstId);
      if (conversation) {
        this.hydrateFromConversation(conversation);
        return;
      }
    }

    const freshConversation = createConversation("", "");
    history.conversations.unshift(toConversationMeta(freshConversation));
    history.activeConversationId = freshConversation.id;
    this.hydrateFromConversation(freshConversation);
  }

  async setActiveConversationModel(model: CompletionModel): Promise<void> {
    const meta = this.findMeta(this.activeConversationId);
    if (!meta) return;

    meta.modelId = model.id;
    meta.modelName = model.name;
    this.activeModelId = model.id;
    this.activeModelName = model.name;
    await this.plugin.saveSettings();
  }

  async newConversation(): Promise<void> {
    const history = this.plugin.settings.chatHistory;
    const conversation = createConversation(
      this.activeModelId,
      this.activeModelName,
    );

    history.conversations.unshift(toConversationMeta(conversation));
    const prunedIds = pruneHistory(history);
    for (const id of prunedIds) {
      await this.storage.delete(id);
    }

    this.hydrateFromConversation(conversation);
    await this.storage.save(conversation);
    await this.plugin.saveSettings();
  }

  async switchToConversation(id: string): Promise<boolean> {
    if (id === this.activeConversationId) return false;

    const meta = this.findMeta(id);
    if (!meta) return false;

    const conversation = await this.storage.load(id);
    if (!conversation) return false;

    this.hydrateFromConversation(conversation);
    await this.plugin.saveSettings();
    return true;
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

    const lastAssistant = [...this.messageHistory].reverse().find((m) => m.role === "assistant");
    this.lastAssistantResponse = lastAssistant?.content ?? "";

    return removed;
  }

  removeLastMessage(): ConversationMessage | null {
    if (this.messageHistory.length === 0) return null;

    const removed = this.messageHistory.pop();
    if (!removed) return null;

    const lastAssistant = [...this.messageHistory].reverse().find((m) => m.role === "assistant");
    this.lastAssistantResponse = lastAssistant?.content ?? "";

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
    metadata?: Pick<ConversationMessage, "modelId" | "provider" | "usage" | "ragSources" | "rewrittenQuery">
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

  async addAndSwitchToConversation(conversation: Conversation): Promise<void> {
    const history = this.plugin.settings.chatHistory;
    history.conversations.unshift(toConversationMeta(conversation));
    const prunedIds = pruneHistory(history);
    for (const id of prunedIds) {
      await this.storage.delete(id);
    }

    this.hydrateFromConversation(conversation);
    await this.storage.save(conversation);
    await this.plugin.saveSettings();
  }

  async deleteConversation(id: string): Promise<void> {
    const history = this.plugin.settings.chatHistory;
    const isActiveConversation = id === this.activeConversationId;

    history.conversations = history.conversations.filter((meta) => meta.id !== id);
    await this.storage.delete(id);

    if (isActiveConversation) {
      if (history.conversations.length > 0) {
        const firstId = history.conversations[0].id;
        const conversation = await this.storage.load(firstId);
        if (conversation) {
          this.hydrateFromConversation(conversation);
        } else {
          const freshConversation = createConversation("", "");
          history.conversations.unshift(toConversationMeta(freshConversation));
          this.hydrateFromConversation(freshConversation);
        }
      } else {
        const freshConversation = createConversation("", "");
        history.conversations.unshift(toConversationMeta(freshConversation));
        this.hydrateFromConversation(freshConversation);
      }
    }

    await this.plugin.saveSettings();
  }

  async persistActiveConversation(): Promise<void> {
    const id = this.activeConversationId;
    if (!id) return;

    const history = this.plugin.settings.chatHistory;
    const metaIndex = history.conversations.findIndex((meta) => meta.id === id);
    if (metaIndex === -1) return;

    const cleanMessages = this.messageHistory.filter((m) => !m.isError).map(stripRagChunkContent);
    const isEmptyConversation = cleanMessages.length === 0 && !this.draft.trim();
    const meta = history.conversations[metaIndex];

    if (isEmptyConversation && !meta.title) {
      history.conversations.splice(metaIndex, 1);
      await this.storage.delete(id);
      if (history.activeConversationId === id) {
        history.activeConversationId = history.conversations[0]?.id ?? null;
      }
      await this.plugin.saveSettings();
      return;
    }

    // Write full conversation to its own file.
    const conversation: Conversation = {
      id,
      title: meta.title,
      createdAt: this.activeCreatedAt || meta.createdAt,
      updatedAt: Date.now(),
      modelId: meta.modelId,
      modelName: meta.modelName,
      messages: cleanMessages,
      draft: this.draft,
    };
    await this.storage.save(conversation);

    // Update lightweight metadata index.
    history.conversations[metaIndex] = toConversationMeta(conversation);
    await this.plugin.saveSettings();
  }

  scheduleDraftSave(): void {
    this.clearDraftSaveTimer();
    this.draftSaveTimer = window.setTimeout(() => {
      this.draftSaveTimer = null;
      void this.persistActiveConversation();
    }, CHAT_DRAFT_SAVE_DELAY_MS);
  }

  clearDraftSaveTimer(): void {
    if (this.draftSaveTimer === null) return;

    window.clearTimeout(this.draftSaveTimer);
    this.draftSaveTimer = null;
  }

  private findMeta(id: string | null): ConversationMeta | null {
    if (!id) return null;
    return this.plugin.settings.chatHistory.conversations.find((meta) => meta.id === id) ?? null;
  }

  private hydrateFromConversation(conversation: Conversation): void {
    this.activeConversationId = conversation.id;
    this.messageHistory = [...conversation.messages];
    this.lastAssistantResponse =
      [...conversation.messages].reverse().find((message) => message.role === "assistant")
        ?.content ?? "";
    this.draft = conversation.draft;
    this.activeModelId = conversation.modelId;
    this.activeModelName = conversation.modelName;
    this.activeCreatedAt = conversation.createdAt;
    this.plugin.settings.chatHistory.activeConversationId = conversation.id;
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
      v.ragSources ? { ...v, ragSources: stripRagSources(v.ragSources) } : v
    ),
  };
}

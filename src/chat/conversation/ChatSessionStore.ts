import type {
  CompletionModel,
  Conversation,
  ConversationMeta,
  ConversationMessage,
} from "../../shared/types";
import type WritingAssistantChat from "../../main";
import { resolveCompletionModel } from "../../utils";
import {
  createConversation,
  generateConversationTitle,
  pruneHistory,
  toConversationMeta,
} from "./conversationUtils";
import type { ConversationStorage } from "./ConversationStorage";
import type { ChatSessionSnapshot } from "../types";
import { ChatSessionMemory } from "./ChatSessionMemory";

const CHAT_DRAFT_SAVE_DELAY_MS = 300;

/**
 * Thin coordinator: delegates in-memory state to ChatSessionMemory,
 * disk I/O to ConversationStorage, and metadata to plugin settings.
 *
 * The public API is unchanged from the pre-split version so that
 * consumers (ChatView, actions, finalization) don't need updating.
 */
export class ChatSessionStore {
  private readonly memory = new ChatSessionMemory();
  private draftSaveTimer: number | null = null;

  constructor(
    private readonly plugin: WritingAssistantChat,
    private readonly storage: ConversationStorage,
  ) {}

  // ── Read-through to memory ──────────────────────────────────────

  getSnapshot(): ChatSessionSnapshot {
    return this.memory.getSnapshot();
  }

  getActiveConversationId(): string | null {
    return this.memory.getActiveConversationId();
  }

  getActiveConversationMeta(): ConversationMeta | null {
    return this.findMeta(this.memory.getActiveConversationId());
  }

  getConversations(): ConversationMeta[] {
    return this.plugin.settings.chatHistory.conversations;
  }

  getResolvedConversationModel(
    meta: ConversationMeta | null = this.findMeta(this.memory.getActiveConversationId()),
  ): CompletionModel | null {
    return meta ? resolveCompletionModel(this.plugin.settings, meta.modelId) : null;
  }

  // ── Write-through to memory ─────────────────────────────────────

  setDraft(draft: string): void {
    this.memory.setDraft(draft);
  }

  appendMessage(message: ConversationMessage): void {
    this.memory.appendMessage(message);
  }

  setLastAssistantResponse(text: string): void {
    this.memory.setLastAssistantResponse(text);
  }

  updateMessageContent(messageId: string, newContent: string): boolean {
    return this.memory.updateMessageContent(messageId, newContent);
  }

  removeMessage(messageId: string): ConversationMessage | null {
    return this.memory.removeMessage(messageId);
  }

  removeLastMessage(): ConversationMessage | null {
    return this.memory.removeLastMessage();
  }

  getMessagesUpToInclusive(messageId: string): ConversationMessage[] {
    return this.memory.getMessagesUpToInclusive(messageId);
  }

  finalizeRegeneration(
    oldMessage: ConversationMessage,
    newContent: string,
    metadata?: Pick<ConversationMessage, "modelId" | "provider" | "usage" | "ragSources" | "rewrittenQuery" | "agenticSteps">,
  ): ConversationMessage {
    return this.memory.finalizeRegeneration(oldMessage, newContent, metadata);
  }

  switchMessageVersion(messageId: string, newIndex: number): boolean {
    return this.memory.switchMessageVersion(messageId, newIndex);
  }

  ensureConversationTitleFromFirstUserMessage(text: string): boolean {
    if (this.memory.getSnapshot().messageHistory.length > 0) return false;

    const meta = this.findMeta(this.memory.getActiveConversationId());
    if (!meta || meta.title) return false;

    meta.title = generateConversationTitle(text);
    return true;
  }

  // ── Coordinated operations (memory + persistence) ───────────────

  async restorePersistedState(): Promise<void> {
    const history = this.plugin.settings.chatHistory;
    const currentId = history.activeConversationId;

    if (currentId) {
      const conversation = await this.storage.load(currentId);
      if (conversation) {
        this.hydrate(conversation);
        return;
      }
    }

    if (history.conversations.length > 0) {
      const firstId = history.conversations[0].id;
      const conversation = await this.storage.load(firstId);
      if (conversation) {
        this.hydrate(conversation);
        return;
      }
    }

    const freshConversation = createConversation("", "");
    history.conversations.unshift(toConversationMeta(freshConversation));
    history.activeConversationId = freshConversation.id;
    this.hydrate(freshConversation);
  }

  async setActiveConversationModel(model: CompletionModel): Promise<void> {
    const meta = this.findMeta(this.memory.getActiveConversationId());
    if (!meta) return;

    meta.modelId = model.id;
    meta.modelName = model.name;
    this.memory.setActiveModel(model.id, model.name);
    await this.plugin.saveSettings();
  }

  async newConversation(): Promise<void> {
    const history = this.plugin.settings.chatHistory;
    const conversation = createConversation(
      this.memory.getActiveModelId(),
      this.memory.getActiveModelName(),
    );

    history.conversations.unshift(toConversationMeta(conversation));
    const prunedIds = pruneHistory(history);
    for (const id of prunedIds) {
      await this.storage.delete(id);
    }

    this.hydrate(conversation);
    await this.storage.save(conversation);
    await this.plugin.saveSettings();
  }

  async switchToConversation(id: string): Promise<boolean> {
    if (id === this.memory.getActiveConversationId()) return false;

    const meta = this.findMeta(id);
    if (!meta) return false;

    const conversation = await this.storage.load(id);
    if (!conversation) return false;

    this.hydrate(conversation);
    await this.plugin.saveSettings();
    return true;
  }

  async addAndSwitchToConversation(conversation: Conversation): Promise<void> {
    const history = this.plugin.settings.chatHistory;
    history.conversations.unshift(toConversationMeta(conversation));
    const prunedIds = pruneHistory(history);
    for (const id of prunedIds) {
      await this.storage.delete(id);
    }

    this.hydrate(conversation);
    await this.storage.save(conversation);
    await this.plugin.saveSettings();
  }

  async deleteConversation(id: string): Promise<void> {
    const history = this.plugin.settings.chatHistory;
    const isActiveConversation = id === this.memory.getActiveConversationId();

    history.conversations = history.conversations.filter((meta) => meta.id !== id);
    await this.storage.delete(id);

    if (isActiveConversation) {
      if (history.conversations.length > 0) {
        const firstId = history.conversations[0].id;
        const conversation = await this.storage.load(firstId);
        if (conversation) {
          this.hydrate(conversation);
        } else {
          this.hydrateWithFresh(history);
        }
      } else {
        this.hydrateWithFresh(history);
      }
    }

    await this.plugin.saveSettings();
  }

  async persistActiveConversation(): Promise<void> {
    const id = this.memory.getActiveConversationId();
    if (!id) return;

    const history = this.plugin.settings.chatHistory;
    const metaIndex = history.conversations.findIndex((meta) => meta.id === id);
    if (metaIndex === -1) return;

    const cleanMessages = this.memory.getCleanMessagesForPersistence();
    const snapshot = this.memory.getSnapshot();
    const isEmptyConversation = cleanMessages.length === 0 && !snapshot.draft.trim();
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

    const conversation: Conversation = {
      id,
      title: meta.title,
      createdAt: this.memory.getActiveCreatedAt() || meta.createdAt,
      updatedAt: Date.now(),
      modelId: meta.modelId,
      modelName: meta.modelName,
      messages: cleanMessages,
      draft: snapshot.draft,
    };
    await this.storage.save(conversation);

    history.conversations[metaIndex] = toConversationMeta(conversation);
    await this.plugin.saveSettings();
  }

  // ── Draft save scheduling ───────────────────────────────────────

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

  // ── Internal helpers ────────────────────────────────────────────

  private findMeta(id: string | null): ConversationMeta | null {
    if (!id) return null;
    return this.plugin.settings.chatHistory.conversations.find((meta) => meta.id === id) ?? null;
  }

  private hydrate(conversation: Conversation): void {
    this.memory.hydrateFromConversation(conversation);
    this.plugin.settings.chatHistory.activeConversationId = conversation.id;
  }

  private hydrateWithFresh(history: { conversations: ConversationMeta[]; activeConversationId: string | null }): void {
    const freshConversation = createConversation("", "");
    history.conversations.unshift(toConversationMeta(freshConversation));
    this.hydrate(freshConversation);
  }
}

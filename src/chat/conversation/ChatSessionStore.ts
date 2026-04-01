import type {
  CompletionModel,
  Conversation,
  ConversationMessage,
  MessageVersion,
} from "../../shared/types";
import type LMStudioWritingAssistant from "../../main";
import { resolveCompletionModel } from "../../utils";
import { createConversation, generateConversationTitle, pruneHistory } from "./conversationUtils";
import type { ChatSessionSnapshot } from "../types";

const CHAT_DRAFT_SAVE_DELAY_MS = 300;

export class ChatSessionStore {
  private activeConversationId: string | null = null;
  private messageHistory: ConversationMessage[] = [];
  private lastAssistantResponse = "";
  private draft = "";
  private draftSaveTimer: number | null = null;
  /** Transient (not persisted): real input token count from the last API response. */
  private lastRequestInputTokens: number | null = null;

  constructor(private readonly plugin: LMStudioWritingAssistant) {}

  getSnapshot(): ChatSessionSnapshot {
    return {
      activeConversationId: this.activeConversationId,
      draft: this.draft,
      messageHistory: [...this.messageHistory],
      lastAssistantResponse: this.lastAssistantResponse,
    };
  }

  getConversations(): Conversation[] {
    return this.plugin.settings.chatHistory.conversations;
  }

  getLastRequestInputTokens(): number | null {
    return this.lastRequestInputTokens;
  }

  setLastRequestInputTokens(tokens: number | null): void {
    this.lastRequestInputTokens = tokens;
  }

  getActiveConversationId(): string | null {
    return this.activeConversationId;
  }

  getActiveConversation(): Conversation | null {
    const id = this.activeConversationId;
    if (!id) return null;

    return (
      this.plugin.settings.chatHistory.conversations.find(
        (conversation) => conversation.id === id
      ) ?? null
    );
  }

  getResolvedConversationModel(
    conversation: Conversation | null = this.getActiveConversation()
  ): CompletionModel | null {
    return conversation ? resolveCompletionModel(this.plugin.settings, conversation.modelId) : null;
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

    const conversation = this.getActiveConversation();
    if (!conversation || conversation.title) return false;

    conversation.title = generateConversationTitle(text);
    return true;
  }

  async restorePersistedState(): Promise<void> {
    const history = this.plugin.settings.chatHistory;
    const currentId = history.activeConversationId;
    const currentConversation = currentId
      ? history.conversations.find((conversation) => conversation.id === currentId)
      : null;

    if (currentConversation) {
      this.hydrateFromConversation(currentConversation);
      return;
    }

    if (history.conversations.length > 0) {
      this.hydrateFromConversation(history.conversations[0]);
      return;
    }

    const freshConversation = createConversation("", "");
    history.conversations.unshift(freshConversation);
    history.activeConversationId = freshConversation.id;
    this.hydrateFromConversation(freshConversation);
  }

  async setActiveConversationModel(model: CompletionModel): Promise<void> {
    const conversation = this.getActiveConversation();
    if (!conversation) return;

    conversation.modelId = model.id;
    conversation.modelName = model.name;
    await this.plugin.saveSettings();
  }

  async newConversation(): Promise<void> {
    const history = this.plugin.settings.chatHistory;
    const currentConv = this.getActiveConversation();
    const conversation = createConversation(
      currentConv?.modelId ?? "",
      currentConv?.modelName ?? ""
    );

    history.conversations.unshift(conversation);
    pruneHistory(history);
    this.hydrateFromConversation(conversation);

    await this.plugin.saveSettings();
  }

  async switchToConversation(id: string): Promise<boolean> {
    if (id === this.activeConversationId) return false;

    const target = this.plugin.settings.chatHistory.conversations.find(
      (conversation) => conversation.id === id
    );
    if (!target) return false;

    this.hydrateFromConversation(target);
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
    metadata?: Pick<ConversationMessage, "modelId" | "provider" | "usage">
  ): ConversationMessage {
    const now = Date.now();

    let versions: MessageVersion[];
    if (oldMessage.versions && oldMessage.versions.length > 0) {
      versions = [...oldMessage.versions];
    } else {
      versions = [{ content: oldMessage.content, createdAt: now, usage: oldMessage.usage }];
    }
    versions.push({ content: newContent, createdAt: now, usage: metadata?.usage });

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
    history.conversations.unshift(conversation);
    pruneHistory(history);
    this.hydrateFromConversation(conversation);
    await this.plugin.saveSettings();
  }

  async deleteConversation(id: string): Promise<void> {
    const history = this.plugin.settings.chatHistory;
    const isActiveConversation = id === this.activeConversationId;

    history.conversations = history.conversations.filter((conversation) => conversation.id !== id);

    if (isActiveConversation) {
      if (history.conversations.length > 0) {
        this.hydrateFromConversation(history.conversations[0]);
      } else {
        const freshConversation = createConversation("", "");
        history.conversations.unshift(freshConversation);
        this.hydrateFromConversation(freshConversation);
      }
    }

    await this.plugin.saveSettings();
  }

  async persistActiveConversation(): Promise<void> {
    const id = this.activeConversationId;
    if (!id) return;

    const history = this.plugin.settings.chatHistory;
    const conversationIndex = history.conversations.findIndex(
      (conversation) => conversation.id === id
    );
    if (conversationIndex === -1) return;

    const conversation = history.conversations[conversationIndex];
    const isEmptyConversation = this.messageHistory.length === 0 && !this.draft.trim();

    if (isEmptyConversation && !conversation.title) {
      history.conversations.splice(conversationIndex, 1);
      if (history.activeConversationId === id) {
        history.activeConversationId = history.conversations[0]?.id ?? null;
      }

      await this.plugin.saveSettings();
      return;
    }

    history.conversations[conversationIndex] = {
      ...conversation,
      messages: this.messageHistory.filter((m) => !m.isError),
      draft: this.draft,
      updatedAt: Date.now(),
    };

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

  private hydrateFromConversation(conversation: Conversation): void {
    this.activeConversationId = conversation.id;
    this.messageHistory = [...conversation.messages];
    this.lastAssistantResponse =
      [...conversation.messages].reverse().find((message) => message.role === "assistant")
        ?.content ?? "";
    this.draft = conversation.draft;
    this.lastRequestInputTokens = null;
    this.plugin.settings.chatHistory.activeConversationId = conversation.id;
  }
}

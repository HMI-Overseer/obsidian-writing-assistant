import { Notice } from "obsidian";
import { MAX_CONVERSATIONS } from "../constants";
import type { ChatSessionStore } from "./conversation/ChatSessionStore";
import type { ChatHistoryDrawer } from "./view/ChatHistoryDrawer";
import type { ChatGenerationOrchestrator } from "./ChatGenerationOrchestrator";

type ConversationControllerDeps = {
  getStore: () => ChatSessionStore | null;
  getDrawer: () => ChatHistoryDrawer | null;
  getOrchestrator: () => ChatGenerationOrchestrator;
  syncConversationUi: () => Promise<void>;
  refreshAvailability: () => Promise<void>;
};

export class ChatConversationController {
  constructor(private readonly deps: ConversationControllerDeps) {}

  async startNewConversation(): Promise<void> {
    const store = this.deps.getStore();
    if (!store) return;

    const conversations = store.getConversations();
    if (conversations.length >= MAX_CONVERSATIONS) {
      const oldestConversation = [...conversations]
        .filter(
          (conversation) => conversation.id !== store.getActiveConversationId()
        )
        .sort((left, right) => left.updatedAt - right.updatedAt)[0];

      if (oldestConversation) {
        const oldestTitle = oldestConversation.title || "Untitled conversation";
        new Notice(
          `History is full (${MAX_CONVERSATIONS}/${MAX_CONVERSATIONS}). Starting a new conversation will remove "${oldestTitle}".`,
          6000
        );
      }
    }

    const orchestrator = this.deps.getOrchestrator();
    if (orchestrator.getIsGenerating()) {
      orchestrator.stopGeneration();
    }

    await store.persistActiveConversation();
    await store.newConversation();
    await this.deps.syncConversationUi();
    void this.deps.refreshAvailability();
    this.deps.getDrawer()?.close();
  }

  async switchConversation(id: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) return;

    if (id === store.getActiveConversationId()) {
      this.deps.getDrawer()?.close();
      return;
    }

    const orchestrator = this.deps.getOrchestrator();
    if (orchestrator.getIsGenerating()) {
      orchestrator.stopGeneration();
    }

    await store.persistActiveConversation();
    const didSwitch = await store.switchToConversation(id);
    if (!didSwitch) return;

    await this.deps.syncConversationUi();
    void this.deps.refreshAvailability();
    this.deps.getDrawer()?.close();
  }

  async deleteConversation(id: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) return;

    await store.deleteConversation(id);
    await this.deps.syncConversationUi();
    void this.deps.refreshAvailability();

    const drawer = this.deps.getDrawer();
    if (drawer?.isOpen()) {
      drawer.open(
        store.getConversations(),
        store.getActiveConversationId()
      );
    }
  }

  toggleHistoryDrawer(): void {
    const drawer = this.deps.getDrawer();
    const store = this.deps.getStore();
    if (!drawer || !store) return;

    if (drawer.isOpen()) {
      drawer.close();
      return;
    }

    drawer.open(store.getConversations(), store.getActiveConversationId());
  }
}

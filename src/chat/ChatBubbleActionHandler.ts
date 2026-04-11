import { Notice } from "obsidian";
import type { ChatGenerationOrchestrator } from "./ChatGenerationOrchestrator";
import type { ContextCapacityUpdater } from "./ContextCapacityUpdater";
import type { ContextInputs } from "./ContextCapacityUpdater";
import { branchConversation } from "./actions/branchConversation";
import type { ChatSessionStore } from "./conversation/ChatSessionStore";
import type { BubbleActionCallbacks } from "./messages/ChatTranscript";
import type { ChatTranscript } from "./messages/ChatTranscript";
import { InlineMessageEditor } from "./messages/InlineMessageEditor";

export type BubbleActionDeps = {
  getStore: () => ChatSessionStore | null;
  getTranscript: () => ChatTranscript | null;
  getOrchestrator: () => ChatGenerationOrchestrator;
  getContextUpdater: () => ContextCapacityUpdater | null;
  syncConversationUi: () => Promise<void>;
  buildContextInputs: () => ContextInputs;
};

export class ChatBubbleActionHandler {
  constructor(private readonly deps: BubbleActionDeps) {}

  createCallbacks(): BubbleActionCallbacks {
    return {
      onCopy: (messageId) => this.handleCopy(messageId),
      onEdit: (messageId) => this.handleEdit(messageId),
      onDelete: (messageId) => this.handleDelete(messageId),
      onBranch: (messageId) => void this.handleBranch(messageId),
      onRegenerate: (messageId) => void this.deps.getOrchestrator().regenerate(messageId),
      onVersionChange: (messageId, newIndex) => void this.handleVersionChange(messageId, newIndex),
    };
  }

  handleCopy(messageId: string): void {
    const snapshot = this.deps.getStore()?.getSnapshot();
    const message = snapshot?.messageHistory.find((m) => m.id === messageId);
    if (!message) return;

    void navigator.clipboard.writeText(message.content).then(() => {
      new Notice("Copied to clipboard");
    });
  }

  handleEdit(messageId: string): void {
    const store = this.deps.getStore();
    const transcript = this.deps.getTranscript();
    if (!store || !transcript) return;

    const bubble = transcript.getBubbleForMessage(messageId);
    const snapshot = store.getSnapshot();
    const message = snapshot.messageHistory.find((m) => m.id === messageId);
    if (!bubble || !message) return;

    const editor = new InlineMessageEditor(bubble, message.content, {
      onSave: async (newContent) => {
        const currentStore = this.deps.getStore();
        if (!currentStore) return;
        currentStore.updateMessageContent(messageId, newContent);
        await currentStore.persistActiveConversation();
        await this.deps.syncConversationUi();
      },
      onCancel: () => {},
    });
    editor.activate();
  }

  async handleDelete(messageId: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) return;

    store.removeMessage(messageId);
    await store.persistActiveConversation();
    await this.deps.syncConversationUi();
  }

  async handleBranch(messageId: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) return;

    this.deps.getOrchestrator().stopGeneration();
    await branchConversation({
      store,
      messageId,
      syncConversationUi: () => this.deps.syncConversationUi(),
    });
  }

  async handleVersionChange(messageId: string, newIndex: number): Promise<void> {
    const store = this.deps.getStore();
    const transcript = this.deps.getTranscript();
    if (!store || !transcript) return;

    store.switchMessageVersion(messageId, newIndex);
    await store.persistActiveConversation();

    const snapshot = store.getSnapshot();
    await transcript.updateBubbleVersion(
      messageId,
      snapshot.messageHistory,
      this.createCallbacks(),
    );
    this.deps.getContextUpdater()?.immediateUpdate(this.deps.buildContextInputs());
  }
}

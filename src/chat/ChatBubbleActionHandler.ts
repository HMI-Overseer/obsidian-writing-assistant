import { Notice } from "obsidian";
import { reportIfRejected, voidAsync } from "../asyncCallbacks";
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

  /**
   * History-mutating toolbar actions (edit/delete/version-switch) persist the
   * shared store, which would race the in-flight `finally` persist of an active
   * generation and leave a surprising final state. Regenerate and branch already
   * guard against this (block / stop respectively); these three did not. Copy is
   * read-only and stays available. Returns true (and warns) when the action must
   * be refused.
   */
  private blockedDuringGeneration(): boolean {
    if (this.deps.getOrchestrator().getIsGenerating()) {
      new Notice("Wait for the current response to finish.");
      return true;
    }
    return false;
  }

  createCallbacks(): BubbleActionCallbacks {
    return {
      onCopy: (messageId) => this.handleCopy(messageId),
      onEdit: (messageId) => this.handleEdit(messageId),
      onDelete: (messageId) =>
        reportIfRejected(this.handleDelete(messageId), "Failed to delete the message."),
      onBranch: (messageId) =>
        reportIfRejected(this.handleBranch(messageId), "Failed to branch the conversation."),
      onRegenerate: (messageId) =>
        reportIfRejected(
          this.deps.getOrchestrator().regenerate(messageId),
          "Failed to regenerate the response.",
        ),
      onVersionChange: (messageId, newIndex) =>
        reportIfRejected(
          this.handleVersionChange(messageId, newIndex),
          "Failed to switch the message version.",
        ),
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
    if (this.blockedDuringGeneration()) return;

    const store = this.deps.getStore();
    const transcript = this.deps.getTranscript();
    if (!store || !transcript) return;

    const bubble = transcript.getBubbleForMessage(messageId);
    const snapshot = store.getSnapshot();
    const message = snapshot.messageHistory.find((m) => m.id === messageId);
    if (!bubble || !message) return;

    const editor = new InlineMessageEditor(bubble, message.content, {
      onSave: voidAsync(async (newContent: string) => {
        // Re-check at commit time: the editor can outlive the start of a new
        // generation, and committing then would race the in-flight persist.
        if (this.blockedDuringGeneration()) return;
        const currentStore = this.deps.getStore();
        if (!currentStore) return;
        currentStore.updateMessageContent(messageId, newContent);
        await currentStore.persistActiveConversation();
        await this.deps.syncConversationUi();
      }, "Failed to save your edit."),
      onCancel: () => {},
    });
    editor.activate();
  }

  async handleDelete(messageId: string): Promise<void> {
    if (this.blockedDuringGeneration()) return;

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
    if (this.blockedDuringGeneration()) return;

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

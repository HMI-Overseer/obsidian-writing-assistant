import { Notice } from "obsidian";
import { reportIfRejected, voidAsync } from "../asyncCallbacks";
import type WritingAssistantChat from "../main";
import type { ChatGenerationOrchestrator } from "./ChatGenerationOrchestrator";
import type { ContextCapacityUpdater } from "./ContextCapacityUpdater";
import type { ContextInputs } from "./ContextCapacityUpdater";
import { branchConversation } from "./actions/branchConversation";
import {
  assistantDisplayText,
  getActiveAssistantRevision,
} from "./conversation/assistantRevisions";
import type { ChatSessionStore } from "./conversation/ChatSessionStore";
import type { BubbleActionCallbacks } from "./messages/ChatTranscript";
import type { ChatTranscript } from "./messages/ChatTranscript";
import { InlineMessageEditor } from "./messages/InlineMessageEditor";
import type { ActionReviewControl } from "./messages/actionLedgerReview";
import { generateId } from "../utils";
import { executeMessageAction } from "./actions/messageActionExecutor";

export type BubbleActionDeps = {
  plugin: WritingAssistantChat;
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
      onEdit: (messageId, proseItemId) =>
        this.handleEdit(messageId, proseItemId),
      onDelete: (messageId) =>
        reportIfRejected(this.handleDelete(messageId), "Failed to delete the message."),
      onBranch: (messageId) =>
        reportIfRejected(this.handleBranch(messageId), "Failed to branch the conversation."),
      onRegenerate: (messageId) =>
        reportIfRejected(
          this.deps.getOrchestrator().regenerate(messageId),
          "Failed to regenerate the response.",
        ),
      onVersionChange: (messageId, revisionId) =>
        reportIfRejected(
          this.handleVersionChange(messageId, revisionId),
          "Failed to switch the message version.",
        ),
      getActionEligibility: (messageId, actionRef, targetId) =>
        this.deps.getStore()?.getActionControlEligibility(
          messageId,
          actionRef,
          targetId,
        ) ?? {
          canApprove: false,
          canDecline: false,
          canApply: false,
          canRetry: false,
          canUndo: false,
        },
      onActionControl: (messageId, actionRef, targetId, control) =>
        reportIfRejected(
          this.handleActionControl(
            messageId,
            actionRef,
            targetId,
            control,
          ),
          "Failed to update the action.",
        ),
    };
  }

  private async handleActionControl(
    messageId: string,
    actionRef: string,
    targetId: string,
    control: ActionReviewControl,
  ): Promise<void> {
    if (this.blockedDuringGeneration()) return;
    const store = this.deps.getStore();
    if (!store) return;
    if (control === "apply" || control === "undo") {
      const changed = await executeMessageAction({
        plugin: this.deps.plugin,
        store,
        messageId,
        actionRef,
        targetId,
        control,
      });
      if (!changed) return;
      await store.persistActiveConversation();
      await this.deps.syncConversationUi();
      return;
    }
    const type =
      control === "approve"
        ? "approved"
        : control === "decline"
          ? "declined"
          : "retry_requested";
    const appended = store.appendEligibleActionEvent(
      messageId,
      actionRef,
      {
        eventId: `event-${generateId()}`,
        type,
        targetId,
        createdAt: Date.now(),
      },
    );
    if (!appended) return;
    await store.persistActiveConversation();
    await this.deps.syncConversationUi();
  }

  handleCopy(messageId: string): void {
    const snapshot = this.deps.getStore()?.getSnapshot();
    const message = snapshot?.messageHistory.find((m) => m.id === messageId);
    if (!message) return;

    void navigator.clipboard.writeText(assistantDisplayText(message)).then(() => {
      new Notice("Copied to clipboard");
    });
  }

  handleEdit(messageId: string, proseItemId?: string): void {
    if (this.blockedDuringGeneration()) return;

    const store = this.deps.getStore();
    const transcript = this.deps.getTranscript();
    if (!store || !transcript) return;

    const bubble = transcript.getBubbleForMessage(messageId);
    const snapshot = store.getSnapshot();
    const message = snapshot.messageHistory.find((m) => m.id === messageId);
    if (!bubble || !message) return;
    const activeRevision = getActiveAssistantRevision(message);
    const proseItem =
      activeRevision?.kind === "turn" && proseItemId
        ? activeRevision.turn.items.find(
            (item) => item.id === proseItemId,
          )
        : null;
    if (
      activeRevision?.kind === "turn" &&
      proseItem?.type !== "prose"
    ) {
      return;
    }
    const originalContent =
      proseItem?.type === "prose"
        ? proseItem.text
        : message.role === "assistant"
          ? assistantDisplayText(message)
          : message.content;

    const editor = new InlineMessageEditor(bubble, originalContent, {
      onSave: voidAsync(async (newContent: string) => {
        // Re-check at commit time: the editor can outlive the start of a new
        // generation, and committing then would race the in-flight persist.
        if (this.blockedDuringGeneration()) return;
        const currentStore = this.deps.getStore();
        if (!currentStore) return;
        let saved = false;
        if (
          message.role === "assistant" &&
          activeRevision?.kind === "turn" &&
          proseItemId
        ) {
          saved = currentStore.editAssistantProseItem(
            messageId,
            proseItemId,
            newContent,
          );
        } else if (
          message.role === "assistant" &&
          activeRevision?.kind === "legacy"
        ) {
          const model = currentStore.getResolvedConversationModel();
          saved = model
            ? currentStore.editLegacyAssistantContent(
                messageId,
                newContent,
                model.provider,
                model.modelId,
              )
            : false;
        } else if (message.role === "user") {
          saved = currentStore.updateUserMessageContent(
            messageId,
            newContent,
          );
        }
        if (!saved) return;
        await currentStore.persistActiveConversation();
        await this.deps.syncConversationUi();
      }, "Failed to save your edit."),
      onCancel: () => {},
    }, proseItemId);
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

  async handleVersionChange(
    messageId: string,
    revisionId: string,
  ): Promise<void> {
    if (this.blockedDuringGeneration()) return;

    const store = this.deps.getStore();
    const transcript = this.deps.getTranscript();
    if (!store || !transcript) return;

    store.switchMessageRevision(messageId, revisionId);
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

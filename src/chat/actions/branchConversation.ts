import { Notice } from "obsidian";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";
import { createBranchConversation } from "../conversation/conversationUtils";

export type BranchOptions = {
  store: ChatSessionStore;
  messageId: string;
  syncConversationUi: () => Promise<void>;
};

export async function branchConversation(options: BranchOptions): Promise<void> {
  const { store, messageId, syncConversationUi } = options;

  const source = store.getActiveConversation();
  if (!source) return;

  const messagesUpTo = store.getMessagesUpToInclusive(messageId);
  if (messagesUpTo.length === 0) return;

  await store.persistActiveConversation();

  const branch = createBranchConversation(source, messagesUpTo, messageId);
  await store.addAndSwitchToConversation(branch);
  await syncConversationUi();

  new Notice("Created branch conversation");
}

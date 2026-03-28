import { Notice } from "obsidian";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";
import { createBranchConversation } from "../conversation/conversationUtils";

export type BranchOptions = {
  store: ChatSessionStore;
  messageId: string;
  syncConversationUi: () => Promise<void>;
  setStatus: (text: string, muted?: boolean) => void;
};

export async function branchConversation(options: BranchOptions): Promise<void> {
  const { store, messageId, syncConversationUi, setStatus } = options;

  const source = store.getActiveConversation();
  if (!source) return;

  const messagesUpTo = store.getMessagesUpToInclusive(messageId);
  if (messagesUpTo.length === 0) return;

  await store.persistActiveConversation();

  const branch = createBranchConversation(source, messagesUpTo, messageId);
  await store.addAndSwitchToConversation(branch);
  await syncConversationUi();

  setStatus("Ready", true);
  new Notice("Created branch conversation");
}

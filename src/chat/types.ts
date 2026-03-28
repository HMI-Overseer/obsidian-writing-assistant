import type { ConversationMessage } from "../shared/types";

export type BubbleRole = "user" | "assistant";

export type ModelAvailabilityState = "loaded" | "unloaded" | "unknown";

export type BubbleRenderOptions = {
  preserveStreaming?: boolean;
};

export type BubbleRefs = {
  role: BubbleRole;
  rowEl: HTMLElement;
  chromeEl: HTMLElement;
  bodyEl: HTMLElement;
  contentEl: HTMLElement;
};

export type ChatLayoutRefs = {
  rootEl: HTMLElement;
  messagesPaneEl: HTMLElement;
  headerMetaEl: HTMLElement;
  statusPillEl: HTMLElement;
  historyBtn: HTMLButtonElement;
  messagesEl: HTMLElement;
  emptyStateEl: HTMLElement;
  commandBarEl: HTMLElement;
  contextChipsEl: HTMLElement;
  textareaEl: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
  stopBtn: HTMLButtonElement;
  modelSelectorBtn: HTMLButtonElement;
  modelSelectorLabelEl: HTMLElement;
  modelSelectorStatusEl: HTMLElement;
  modelDropdownEl: HTMLElement;
};

export type ChatSessionSnapshot = {
  activeConversationId: string | null;
  draft: string;
  messageHistory: ConversationMessage[];
  lastAssistantResponse: string;
};

import type { ConversationMessage } from "../shared/types";

export type ChatMode = "plan" | "conversation" | "edit";

export type BubbleRole = "user" | "assistant";

export type ModelAvailabilityState = "loaded" | "unloaded" | "unknown";

export type BubbleRenderOptions = {
  preserveStreaming?: boolean;
};

export type BubbleRefs = {
  role: BubbleRole;
  rowEl: HTMLElement;
  columnEl: HTMLElement;
  chromeEl: HTMLElement;
  bodyEl: HTMLElement;
  contentEl: HTMLElement;
};

export type ChatLayoutRefs = {
  rootEl: HTMLElement;
  messagesPaneEl: HTMLElement;
  headerMetaEl: HTMLElement;
  historyBtn: HTMLButtonElement;
  paramsBtn: HTMLButtonElement;
  shellEl: HTMLElement;
  messagesEl: HTMLElement;
  emptyStateEl: HTMLElement;
  commandBarEl: HTMLElement;
  contextChipsEl: HTMLElement;
  textareaEl: HTMLTextAreaElement;
  modeToggleEl: HTMLElement;
  actionBtn: HTMLButtonElement;
  modelSelectorBtn: HTMLElement;
  modelSelectorLabelEl: HTMLElement;
  modelSelectorStatusEl: HTMLElement;
  modelSelectorChevronEl: HTMLElement;
  modelDropdownEl: HTMLElement;
};

export type ChatSessionSnapshot = {
  activeConversationId: string | null;
  draft: string;
  messageHistory: ConversationMessage[];
  lastAssistantResponse: string;
};

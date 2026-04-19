import type { Attachment, ConversationMessage } from "../shared/types";

export type ChatMode = "plan" | "conversation" | "edit";

export type BubbleRole = "user" | "assistant";


export type BubbleRenderOptions = {
  preserveStreaming?: boolean;
  attachments?: Attachment[];
};

export type BubbleRefs = {
  role: BubbleRole;
  rowEl: HTMLElement;
  columnEl: HTMLElement;
  chromeEl: HTMLElement;
  /** Container for the agentic step timeline. Sits between the role label and the bubble body. Empty for non-agentic messages. */
  timelineEl: HTMLElement;
  bodyEl: HTMLElement;
  contentEl: HTMLElement;
};

export type ChatLayoutRefs = {
  rootEl: HTMLElement;
  messagesPaneEl: HTMLElement;
  headerMetaEl: HTMLElement;
  historyBtn: HTMLButtonElement;
  shellEl: HTMLElement;
  messagesEl: HTMLElement;
  emptyStateEl: HTMLElement;
  contextChipsEl: HTMLElement;
  textareaEl: HTMLTextAreaElement;
  modeToggleEl: HTMLElement;
  toolUseIndicatorEl: HTMLElement;
  toolUsePopoverEl: HTMLElement;
  knowledgeIndicatorEl: HTMLElement;
  knowledgePopoverEl: HTMLElement;
  visionIndicatorEl: HTMLElement;
  attachmentsEl: HTMLElement;
  actionBtn: HTMLButtonElement;
  modelSelectorBtn: HTMLElement;
  modelSelectorLabelEl: HTMLElement;
  modelSelectorStatusEl: HTMLElement;
  modelSelectorChevronEl: HTMLElement;
  modelDropdownEl: HTMLElement;
  profileSettingsBtn: HTMLButtonElement;
  profileSettingsPopoverEl: HTMLElement;
  contextCapacityEl: HTMLElement;
  generateResponseBtn: HTMLButtonElement;
  contextAddBtnEl: HTMLButtonElement;
  contextPickerPopoverEl: HTMLElement;
};

export type ChatSessionSnapshot = {
  activeConversationId: string | null;
  draft: string;
  messageHistory: ConversationMessage[];
  lastAssistantResponse: string;
};

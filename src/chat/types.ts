import type { Attachment, ConversationMessage } from "../shared/types";

export type BubbleRole = "user" | "assistant";

/**
 * Muted placeholder shown for a stopped (aborted) generation that produced no
 * text. Shared by the live finalizer and the persisted-history renderer so a
 * claudecode turn persisted with empty content (section 6.1 persist-always) shows the
 * same face whether it just aborted or was reloaded from disk.
 */
export const GENERATION_STOPPED_LABEL = "Generation stopped.";

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
  newChatBtn: HTMLButtonElement;
  historyBtn: HTMLButtonElement;
  shellEl: HTMLElement;
  messagesEl: HTMLElement;
  emptyStateEl: HTMLElement;
  contextChipsEl: HTMLElement;
  textareaEl: HTMLTextAreaElement;
  posturePillEl: HTMLButtonElement;
  postureMenuEl: HTMLElement;
  toolUseIndicatorEl: HTMLElement;
  toolUsePopoverEl: HTMLElement;
  knowledgeIndicatorEl: HTMLElement;
  knowledgePopoverEl: HTMLElement;
  visionIndicatorEl: HTMLElement;
  reasoningPillEl: HTMLButtonElement;
  reasoningMenuEl: HTMLElement;
  overflowBtnEl: HTMLButtonElement;
  overflowMenuEl: HTMLElement;
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

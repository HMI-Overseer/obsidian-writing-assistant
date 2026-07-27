import type { Attachment, ConversationMessage } from "../shared/types";
import type { AssistantTurnView } from "./messages/AssistantTurnView";

export type BubbleRole = "user" | "assistant";

/**
 * Muted placeholder shown for a stopped (aborted) generation that produced no
 * text. Shared by the live finalizer and the persisted-history renderer so a
 * claudecode turn persisted with empty content shows the
 * same face whether it just aborted or was reloaded from disk.
 */
export const GENERATION_STOPPED_LABEL = "Generation stopped.";

export type BubbleRenderOptions = {
  preserveStreaming?: boolean;
  attachments?: Attachment[];
};

type BubbleRefsBase = {
  rowEl: HTMLElement;
  columnEl: HTMLElement;
  chromeEl: HTMLElement;
};

export type UserBubbleRefs = BubbleRefsBase & {
  role: "user";
  bodyEl: HTMLElement;
  contentEl: HTMLElement;
};

export type AssistantBubbleRefs = BubbleRefsBase & {
  role: "assistant";
  turnHostEl: HTMLElement;
  turnView: AssistantTurnView;
};

export type BubbleRefs = UserBubbleRefs | AssistantBubbleRefs;

export type ChatLayoutRefs = {
  rootEl: HTMLElement;
  messagesPaneEl: HTMLElement;
  headerMetaEl: HTMLElement;
  newChatBtn: HTMLButtonElement;
  historyBtn: HTMLButtonElement;
  shellEl: HTMLElement;
  messagesEl: HTMLElement;
  emptyStateEl: HTMLElement;
  emptyCopyEl: HTMLElement;
  composerPanelEl: HTMLElement;
  composerNormalBodyEl: HTMLElement;
  composerInteractionEl: HTMLElement;
  composerFooterEl: HTMLElement;
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

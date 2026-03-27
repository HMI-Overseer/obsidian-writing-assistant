import { setIcon } from "obsidian";
import type { ChatLayoutRefs } from "../types";

export function createChatLayout(contentEl: HTMLElement): ChatLayoutRefs {
  contentEl.empty();
  contentEl.addClass("lmsa-root");

  const shell = contentEl.createDiv({ cls: "lmsa-shell" });

  const header = shell.createDiv({ cls: "lmsa-header" });
  const titleGroup = header.createDiv({ cls: "lmsa-header-copy" });
  titleGroup.createEl("div", { cls: "lmsa-header-title", text: "LM Studio Chat" });
  const headerMetaEl = titleGroup.createEl("div", { cls: "lmsa-header-meta" });

  const headerActions = header.createDiv({ cls: "lmsa-header-actions" });
  const statusPillEl = headerActions.createDiv({ cls: "lmsa-status-pill lmsa-ui-pill" });

  const historyBtn = headerActions.createEl("button", {
    cls: "lmsa-header-btn lmsa-ui-icon-btn",
    attr: { "aria-label": "Chat history" },
  }) as HTMLButtonElement;
  setIcon(historyBtn, "clock");

  const messagesPaneEl = shell.createDiv({ cls: "lmsa-messages-pane" });
  const emptyStateEl = messagesPaneEl.createDiv({ cls: "lmsa-empty-view" });
  emptyStateEl.createEl("div", { cls: "lmsa-empty-title", text: "Start a conversation" });
  emptyStateEl.createEl("div", {
    cls: "lmsa-empty-copy",
    text: "Ask a question, paste a passage, or use a quick command to rewrite, expand, or tighten your draft.",
  });
  const messagesEl = messagesPaneEl.createDiv({ cls: "lmsa-messages" });

  const composer = shell.createDiv({ cls: "lmsa-composer" });
  const commandBarEl = composer.createDiv({ cls: "lmsa-command-bar" });
  const composerPanel = composer.createDiv({ cls: "lmsa-composer-panel lmsa-ui-panel" });
  const contextChipsEl = composerPanel.createDiv({ cls: "lmsa-composer-chips" });

  const textareaEl = composerPanel.createEl("textarea", {
    cls: "lmsa-textarea",
    attr: { placeholder: "Send a message to the model...", rows: "3" },
  }) as HTMLTextAreaElement;

  const composerFooter = composerPanel.createDiv({ cls: "lmsa-composer-footer" });
  const composerFooterMeta = composerFooter.createDiv({ cls: "lmsa-composer-footer-meta" });
  const modelSelectorWrap = composerFooterMeta.createDiv({ cls: "lmsa-model-selector-wrap" });

  const modelSelectorBtn = modelSelectorWrap.createEl("button", {
    cls: "lmsa-model-selector-btn lmsa-ui-control-btn",
  }) as HTMLButtonElement;
  const iconSpan = modelSelectorBtn.createEl("span", { cls: "lmsa-model-selector-icon" });
  setIcon(iconSpan, "cpu");
  const modelSelectorLabelEl = modelSelectorBtn.createEl("span", {
    cls: "lmsa-model-selector-label",
  });
  const modelSelectorStatusEl = modelSelectorBtn.createEl("span", {
    cls: "lmsa-model-selector-status is-hidden",
  });
  const chevronSpan = modelSelectorBtn.createEl("span", { cls: "lmsa-model-selector-chevron" });
  setIcon(chevronSpan, "chevron-up");

  const modelDropdownEl = modelSelectorWrap.createDiv({ cls: "lmsa-model-dropdown" });
  modelDropdownEl.style.display = "none";

  composerFooterMeta.createDiv({
    cls: "lmsa-compose-hint",
    text: "Enter to send, Shift+Enter for newline",
  });

  const buttonRow = composerFooter.createDiv({ cls: "lmsa-btn-row" });
  const stopBtn = buttonRow.createEl("button", {
    cls: "lmsa-secondary-btn lmsa-stop-btn lmsa-ui-btn lmsa-ui-btn-secondary",
    text: "Stop",
  }) as HTMLButtonElement;
  stopBtn.disabled = true;

  const sendBtn = buttonRow.createEl("button", {
    cls: "lmsa-send-btn lmsa-ui-btn lmsa-ui-btn-primary",
    text: "Send",
  }) as HTMLButtonElement;

  return {
    rootEl: contentEl,
    messagesPaneEl,
    headerMetaEl,
    statusPillEl,
    historyBtn,
    messagesEl,
    emptyStateEl,
    commandBarEl,
    contextChipsEl,
    textareaEl,
    sendBtn,
    stopBtn,
    modelSelectorBtn,
    modelSelectorLabelEl,
    modelSelectorStatusEl,
    modelDropdownEl,
  };
}

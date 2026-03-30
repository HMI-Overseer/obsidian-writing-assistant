import { setIcon } from "obsidian";
import type { ChatLayoutRefs } from "../types";

export function createChatLayout(contentEl: HTMLElement): ChatLayoutRefs {
  contentEl.empty();
  contentEl.addClass("lmsa-root");

  const shell = contentEl.createDiv({ cls: "lmsa-shell" });

  const collapsedOverlay = shell.createDiv({ cls: "lmsa-collapsed-overlay" });
  collapsedOverlay.createEl("div", {
    cls: "lmsa-collapsed-text",
    text: "Widen the panel to use the chat",
  });

  const header = shell.createDiv({ cls: "lmsa-header" });
  const titleGroup = header.createDiv({ cls: "lmsa-header-copy" });
  titleGroup.createEl("div", { cls: "lmsa-header-title", text: "Obsidian Writing Assistant Chat" });

  const headerMetaWrap = titleGroup.createDiv({ cls: "lmsa-header-meta-wrap" });
  const headerMetaBtn = headerMetaWrap.createDiv({ cls: "lmsa-header-meta" });
  const headerMetaLabel = headerMetaBtn.createEl("span", { cls: "lmsa-header-meta-label" });
  const modelSelectorStatusEl = headerMetaBtn.createEl("span", {
    cls: "lmsa-model-selector-status is-hidden",
  });
  const headerMetaChevron = headerMetaBtn.createEl("span", { cls: "lmsa-header-meta-chevron" });
  setIcon(headerMetaChevron, "chevron-down");

  const modelDropdownEl = headerMetaWrap.createDiv({ cls: "lmsa-model-dropdown" });
  modelDropdownEl.style.display = "none";

  const profileSettingsBtn = headerMetaWrap.createEl("button", {
    cls: "lmsa-profile-settings-btn",
    attr: { "aria-label": "Profile settings" },
  }) as HTMLButtonElement;
  setIcon(profileSettingsBtn, "settings");

  const profileSettingsPopoverEl = headerMetaWrap.createDiv({ cls: "lmsa-profile-popover" });
  profileSettingsPopoverEl.style.display = "none";

  const headerActions = header.createDiv({ cls: "lmsa-header-actions" });
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
    attr: { placeholder: "Send a message to the model...", rows: "2" },
  }) as HTMLTextAreaElement;

  const composerFooter = composerPanel.createDiv({ cls: "lmsa-composer-footer" });

  const contextCapacityEl = composerFooter.createDiv({ cls: "lmsa-context-capacity" });
  contextCapacityEl.style.display = "none";
  const capacityBar = contextCapacityEl.createDiv({ cls: "lmsa-context-capacity-bar" });
  capacityBar.createDiv({ cls: "lmsa-context-capacity-fill" });
  contextCapacityEl.createEl("span", { cls: "lmsa-context-capacity-label" });

  const usageSummaryEl = composerFooter.createDiv({ cls: "lmsa-usage-summary" });
  usageSummaryEl.style.display = "none";

  const composerFooterActions = composerFooter.createDiv({ cls: "lmsa-composer-footer-actions" });
  const modeToggleEl = composerFooterActions.createDiv({ cls: "lmsa-mode-toggle" });

  const actionBtn = composerFooterActions.createEl("button", {
    cls: "lmsa-action-btn lmsa-ui-btn-primary",
  }) as HTMLButtonElement;
  setIcon(actionBtn, "arrow-up");

  return {
    rootEl: contentEl,
    messagesPaneEl,
    headerMetaEl: headerMetaLabel,
    historyBtn,
    shellEl: shell,
    messagesEl,
    emptyStateEl,
    commandBarEl,
    contextChipsEl,
    textareaEl,
    modeToggleEl,
    actionBtn,
    modelSelectorBtn: headerMetaBtn,
    modelSelectorLabelEl: headerMetaLabel,
    modelSelectorStatusEl,
    modelSelectorChevronEl: headerMetaChevron,
    modelDropdownEl,
    profileSettingsBtn,
    profileSettingsPopoverEl,
    usageSummaryEl,
    contextCapacityEl,
  };
}

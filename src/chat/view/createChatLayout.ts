import { setIcon } from "obsidian";
import type { ChatLayoutRefs } from "../types";

const SVG_NS = "http://www.w3.org/2000/svg";
const GLASS_FILTER_ID = "lmsa-glass";

function ensureGlassFilter(root: HTMLElement): void {
  if (root.querySelector(`#${GLASS_FILTER_ID}`)) return;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("role", "presentation");
  svg.classList.add("lmsa-hidden");

  const filter = document.createElementNS(SVG_NS, "filter");
  filter.setAttribute("id", GLASS_FILTER_ID);
  filter.setAttribute("x", "-50%");
  filter.setAttribute("y", "-50%");
  filter.setAttribute("width", "200%");
  filter.setAttribute("height", "200%");
  filter.setAttribute("primitiveUnits", "objectBoundingBox");

  const turbulence = document.createElementNS(SVG_NS, "feTurbulence");
  turbulence.setAttribute("type", "fractalNoise");
  turbulence.setAttribute("baseFrequency", "0.50 0.99");
  turbulence.setAttribute("numOctaves", "2");
  turbulence.setAttribute("seed", "5");
  turbulence.setAttribute("result", "map");

  const blur = document.createElementNS(SVG_NS, "feGaussianBlur");
  blur.setAttribute("in", "SourceGraphic");
  blur.setAttribute("stdDeviation", "0.1");
  blur.setAttribute("result", "blur");

  const displacement = document.createElementNS(SVG_NS, "feDisplacementMap");
  displacement.setAttribute("in", "blur");
  displacement.setAttribute("in2", "map");
  displacement.setAttribute("scale", "0.1");
  displacement.setAttribute("xChannelSelector", "R");
  displacement.setAttribute("yChannelSelector", "G");

  filter.append(turbulence, blur, displacement);
  svg.appendChild(filter);
  root.prepend(svg);
}

export function createChatLayout(contentEl: HTMLElement): ChatLayoutRefs {
  contentEl.empty();
  contentEl.addClass("lmsa-root");
  ensureGlassFilter(contentEl);

  const shell = contentEl.createDiv({ cls: "lmsa-shell" });

  const collapsedOverlay = shell.createDiv({ cls: "lmsa-collapsed-overlay" });
  collapsedOverlay.createEl("div", {
    cls: "lmsa-collapsed-text",
    text: "Widen the panel to use the chat",
  });

  const header = shell.createDiv({ cls: "lmsa-header" });
  const titleGroup = header.createDiv({ cls: "lmsa-header-copy" });
  titleGroup.createEl("div", { cls: "lmsa-header-title", text: "Obsidian writing assistant chat" });

  const headerMetaWrap = titleGroup.createDiv({ cls: "lmsa-header-meta-wrap" });
  const headerMetaBtn = headerMetaWrap.createDiv({ cls: "lmsa-header-meta" });
  const headerMetaLabel = headerMetaBtn.createEl("span", { cls: "lmsa-header-meta-label" });
  const modelSelectorStatusEl = headerMetaBtn.createEl("span", {
    cls: "lmsa-model-selector-status is-hidden",
  });
  const headerMetaChevron = headerMetaBtn.createEl("span", { cls: "lmsa-header-meta-chevron" });
  setIcon(headerMetaChevron, "chevron-down");

  const modelDropdownEl = headerMetaWrap.createDiv({ cls: "lmsa-model-dropdown lmsa-hidden" });

  const profileSettingsBtn = headerMetaWrap.createEl("button", {
    cls: "lmsa-profile-settings-btn",
    attr: { "aria-label": "Profile settings" },
  }) as HTMLButtonElement;
  setIcon(profileSettingsBtn, "settings");

  const profileSettingsPopoverEl = headerMetaWrap.createDiv({ cls: "lmsa-profile-popover lmsa-hidden" });

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

  const generateResponseBtn = composer.createEl("button", {
    cls: "lmsa-generate-response-btn lmsa-ui-pill-button lmsa-hidden",
    attr: { "aria-label": "Generate response" },
  }) as HTMLButtonElement;
  const genBtnIcon = generateResponseBtn.createEl("span", { cls: "lmsa-generate-response-icon" });
  setIcon(genBtnIcon, "sparkles");
  generateResponseBtn.createEl("span", { text: "Generate response" });
  generateResponseBtn.createEl("span", {
    cls: "lmsa-generate-response-loading",
    text: "Loading...",
  });

  const commandBarEl = composer.createDiv({ cls: "lmsa-command-bar" });
  const composerPanel = composer.createDiv({ cls: "lmsa-composer-panel lmsa-ui-panel" });
  const contextChipsEl = composerPanel.createDiv({ cls: "lmsa-composer-chips" });

  const textareaEl = composerPanel.createEl("textarea", {
    cls: "lmsa-textarea",
    attr: { placeholder: "Send a message to the model...", rows: "2" },
  }) as HTMLTextAreaElement;

  const composerFooter = composerPanel.createDiv({ cls: "lmsa-composer-footer" });

  const contextCapacityEl = composerFooter.createDiv({ cls: "lmsa-context-capacity lmsa-hidden" });
  contextCapacityEl.createEl("span", { cls: "lmsa-context-capacity-label" });

  const usageSummaryEl = composerFooter.createDiv({ cls: "lmsa-usage-summary lmsa-hidden" });

  const composerFooterActions = composerFooter.createDiv({ cls: "lmsa-composer-footer-actions" });
  const toolUseIndicatorEl = composerFooterActions.createDiv({ cls: "lmsa-tool-use-indicator" });
  setIcon(toolUseIndicatorEl, "wrench");
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
    toolUseIndicatorEl,
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
    generateResponseBtn,
  };
}

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

  const header = shell.createDiv({ cls: "lmsa-chat-header" });
  const titleGroup = header.createDiv({ cls: "lmsa-chat-header-copy" });
  titleGroup.createEl("div", { cls: "lmsa-chat-header-title", text: "Writing assistant chat" });

  const headerMetaWrap = titleGroup.createDiv({ cls: "lmsa-chat-header-meta-wrap" });
  const headerMetaBtn = headerMetaWrap.createDiv({ cls: "lmsa-chat-header-meta" });
  const headerMetaLabel = headerMetaBtn.createEl("span", { cls: "lmsa-chat-header-meta-label" });
  const modelSelectorStatusEl = headerMetaBtn.createEl("span", {
    cls: "lmsa-model-selector-status is-hidden",
  });
  const headerMetaChevron = headerMetaBtn.createEl("span", { cls: "lmsa-chat-header-meta-chevron" });
  setIcon(headerMetaChevron, "chevron-down");

  const modelDropdownEl = headerMetaWrap.createDiv({ cls: "lmsa-model-dropdown lmsa-hidden" });

  const profileSettingsBtn = headerMetaWrap.createEl("button", {
    cls: "lmsa-profile-settings-btn",
    attr: { "aria-label": "Profile settings" },
  }) as HTMLButtonElement;
  setIcon(profileSettingsBtn, "settings");

  const profileSettingsPopoverEl = headerMetaWrap.createDiv({ cls: "lmsa-profile-popover lmsa-hidden" });

  const headerActions = header.createDiv({ cls: "lmsa-chat-header-actions" });
  const historyBtn = headerActions.createEl("button", {
    cls: "lmsa-chat-header-btn lmsa-ui-icon-btn",
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
  const messagesEl = messagesPaneEl.createDiv({ cls: "lmsa-chat-window-messages" });

  const composer = shell.createDiv({ cls: "lmsa-chat-composer" });

  const generateResponseBtn = composer.createEl("button", {
    cls: "lmsa-chat-composer-generate-btn lmsa-hidden",
    attr: { "aria-label": "Generate response" },
  }) as HTMLButtonElement;
  const genBtnIcon = generateResponseBtn.createEl("span", { cls: "lmsa-chat-composer-generate-icon" });
  setIcon(genBtnIcon, "sparkles");
  generateResponseBtn.createEl("span", { text: "Generate response" });

  const composerPanel = composer.createDiv({ cls: "lmsa-chat-composer-panel" });
  const contextPickerPopoverEl = composerPanel.createDiv({ cls: "lmsa-context-picker-popover lmsa-hidden" });
  const contextChipsEl = composerPanel.createDiv({ cls: "lmsa-chat-composer-chips" });
  const contextAddBtnEl = contextChipsEl.createEl("button", {
    cls: "lmsa-chat-composer-add-context-btn",
    attr: { "aria-label": "Add context" },
  }) as HTMLButtonElement;
  setIcon(contextAddBtnEl, "plus");

  const textareaEl = composerPanel.createEl("textarea", {
    cls: "lmsa-chat-composer-textarea",
    attr: { placeholder: "Send a message to the model...", rows: "2" },
  }) as HTMLTextAreaElement;

  const composerFooter = composerPanel.createDiv({ cls: "lmsa-chat-composer-footer" });

  const contextCapacityEl = composerFooter.createDiv({ cls: "lmsa-chat-composer-context-capacity lmsa-hidden" });

  const ringSvg = document.createElementNS(SVG_NS, "svg");
  ringSvg.classList.add("lmsa-context-ring-svg");
  ringSvg.setAttribute("viewBox", "0 0 32 32");
  ringSvg.setAttribute("role", "presentation");

  const trackCircle = document.createElementNS(SVG_NS, "circle");
  trackCircle.classList.add("lmsa-context-ring-track");
  trackCircle.setAttribute("cx", "16");
  trackCircle.setAttribute("cy", "16");
  trackCircle.setAttribute("r", "12");
  trackCircle.setAttribute("fill", "none");
  trackCircle.setAttribute("stroke-width", "3");

  const fillCircle = document.createElementNS(SVG_NS, "circle");
  fillCircle.classList.add("lmsa-context-ring-fill");
  fillCircle.setAttribute("cx", "16");
  fillCircle.setAttribute("cy", "16");
  fillCircle.setAttribute("r", "12");
  fillCircle.setAttribute("fill", "none");
  fillCircle.setAttribute("stroke-width", "3");
  fillCircle.setAttribute("stroke-linecap", "round");
  fillCircle.setAttribute("transform", "rotate(-90 16 16)");
  const circumference = 2 * Math.PI * 12;
  fillCircle.setAttribute("stroke-dasharray", String(circumference));
  fillCircle.setAttribute("stroke-dashoffset", String(circumference));

  ringSvg.append(trackCircle, fillCircle);
  contextCapacityEl.appendChild(ringSvg);

  const composerFooterActions = composerFooter.createDiv({ cls: "lmsa-chat-composer-footer-actions" });
  const toolWrap = composerFooterActions.createDiv({ cls: "lmsa-chat-composer-tool-wrap" });
  const toolUseIndicatorEl = toolWrap.createDiv({ cls: "lmsa-chat-composer-tool-indicator" });
  setIcon(toolUseIndicatorEl, "wrench");
  const knowledgeWrap = composerFooterActions.createDiv({ cls: "lmsa-chat-composer-knowledge-wrap" });
  const knowledgeIndicatorEl = knowledgeWrap.createDiv({ cls: "lmsa-chat-composer-knowledge-indicator" });
  setIcon(knowledgeIndicatorEl, "database");
  const visionIndicatorEl = composerFooterActions.createDiv({ cls: "lmsa-chat-composer-vision-indicator" });
  setIcon(visionIndicatorEl, "eye");
  const modeToggleEl = composerFooterActions.createDiv({ cls: "lmsa-chat-composer-mode-toggle" });

  const actionBtn = composerFooterActions.createEl("button", {
    cls: "lmsa-chat-composer-send-btn",
  }) as HTMLButtonElement;
  setIcon(actionBtn, "arrow-up");

  // Popovers are children of the footer (not the small wrap divs) so they
  // position relative to the full footer width and aren't clipped by narrow wraps.
  const toolUsePopoverEl = composerFooter.createDiv({ cls: "lmsa-tool-popover lmsa-hidden" });
  const knowledgePopoverEl = composerFooter.createDiv({ cls: "lmsa-knowledge-popover lmsa-hidden" });

  return {
    rootEl: contentEl,
    messagesPaneEl,
    headerMetaEl: headerMetaLabel,
    historyBtn,
    shellEl: shell,
    messagesEl,
    emptyStateEl,
    contextChipsEl,
    textareaEl,
    modeToggleEl,
    toolUseIndicatorEl,
    toolUsePopoverEl,
    knowledgeIndicatorEl,
    knowledgePopoverEl,
    visionIndicatorEl,
    actionBtn,
    modelSelectorBtn: headerMetaBtn,
    modelSelectorLabelEl: headerMetaLabel,
    modelSelectorStatusEl,
    modelSelectorChevronEl: headerMetaChevron,
    modelDropdownEl,
    profileSettingsBtn,
    profileSettingsPopoverEl,
    contextCapacityEl,
    generateResponseBtn,
    contextAddBtnEl,
    contextPickerPopoverEl,
  };
}

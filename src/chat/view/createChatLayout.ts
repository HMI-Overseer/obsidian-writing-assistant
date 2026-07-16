import { setIcon } from "obsidian";
import type { ChatLayoutRefs } from "../types";

const SVG_NS = "http://www.w3.org/2000/svg";
const GLASS_FILTER_ID = "lmsa-glass";

function ensureGlassFilter(root: HTMLElement): void {
  if (root.querySelector(`#${GLASS_FILTER_ID}`)) return;

  // Build against the view's own document (root.ownerDocument), not the bare global
  // `document`: if the leaf is dragged into a popout window the filter must be created
  // in that window's document, not the main window's. See ADR-0024 and Phase 7.
  const doc = root.ownerDocument;

  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("role", "presentation");
  svg.classList.add("lmsa-hidden");

  const filter = doc.createElementNS(SVG_NS, "filter");
  filter.setAttribute("id", GLASS_FILTER_ID);
  filter.setAttribute("x", "-50%");
  filter.setAttribute("y", "-50%");
  filter.setAttribute("width", "200%");
  filter.setAttribute("height", "200%");
  filter.setAttribute("primitiveUnits", "objectBoundingBox");

  const turbulence = doc.createElementNS(SVG_NS, "feTurbulence");
  turbulence.setAttribute("type", "fractalNoise");
  turbulence.setAttribute("baseFrequency", "0.50 0.99");
  turbulence.setAttribute("numOctaves", "2");
  turbulence.setAttribute("seed", "5");
  turbulence.setAttribute("result", "map");

  const blur = doc.createElementNS(SVG_NS, "feGaussianBlur");
  blur.setAttribute("in", "SourceGraphic");
  blur.setAttribute("stdDeviation", "0.1");
  blur.setAttribute("result", "blur");

  const displacement = doc.createElementNS(SVG_NS, "feDisplacementMap");
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
  collapsedOverlay.createDiv({
    cls: "lmsa-collapsed-text",
    text: "Widen the panel to use the chat",
  });

  const header = shell.createDiv({ cls: "lmsa-chat-header" });
  const titleGroup = header.createDiv({ cls: "lmsa-chat-header-copy" });
  titleGroup.createDiv({ cls: "lmsa-chat-header-title", text: "Writing assistant chat" });

  const headerMetaWrap = titleGroup.createDiv({ cls: "lmsa-chat-header-meta-wrap" });
  const headerMetaBtn = headerMetaWrap.createDiv({ cls: "lmsa-chat-header-meta" });
  const headerMetaLabel = headerMetaBtn.createSpan({ cls: "lmsa-chat-header-meta-label" });
  const modelSelectorStatusEl = headerMetaBtn.createSpan({
    cls: "lmsa-model-selector-status is-hidden",
  });
  const headerMetaChevron = headerMetaBtn.createSpan({ cls: "lmsa-chat-header-meta-chevron" });
  setIcon(headerMetaChevron, "chevron-down");

  const modelDropdownEl = headerMetaWrap.createDiv({ cls: "lmsa-model-dropdown lmsa-hidden" });

  const profileSettingsBtn = headerMetaWrap.createEl("button", {
    cls: "lmsa-profile-settings-btn",
    attr: { "aria-label": "Profile settings" },
  });
  setIcon(profileSettingsBtn, "settings");

  const profileSettingsPopoverEl = headerMetaWrap.createDiv({ cls: "lmsa-profile-popover lmsa-hidden" });

  const headerActions = header.createDiv({ cls: "lmsa-chat-header-actions" });
  const newChatBtn = headerActions.createEl("button", {
    cls: "lmsa-chat-header-btn lmsa-ui-icon-btn",
    attr: { "aria-label": "New chat" },
  });
  setIcon(newChatBtn, "file-pen");
  const historyBtn = headerActions.createEl("button", {
    cls: "lmsa-chat-header-btn lmsa-ui-icon-btn",
    attr: { "aria-label": "Chat history" },
  });
  setIcon(historyBtn, "clock");

  const messagesPaneEl = shell.createDiv({ cls: "lmsa-messages-pane" });
  const emptyStateEl = messagesPaneEl.createDiv({ cls: "lmsa-empty-view" });
  emptyStateEl.createDiv({ cls: "lmsa-empty-title", text: "Start a conversation" });
  // Host for the writing-prompt carousel; EmptyStateCarousel builds the track / slides / nav inside it
  // and owns the slide + auto-advance behaviour (mirrors how ChatHistoryDrawer fills the messages pane).
  const emptyCopyEl = emptyStateEl.createDiv({ cls: "lmsa-empty-copy" });
  const messagesEl = messagesPaneEl.createDiv({ cls: "lmsa-chat-window-messages" });

  const composer = shell.createDiv({ cls: "lmsa-chat-composer" });

  const generateResponseBtn = composer.createEl("button", {
    cls: "lmsa-chat-composer-generate-btn lmsa-hidden",
    attr: { "aria-label": "Generate response" },
  });
  const genBtnIcon = generateResponseBtn.createSpan({ cls: "lmsa-chat-composer-generate-icon" });
  setIcon(genBtnIcon, "sparkles");
  generateResponseBtn.createSpan({ text: "Generate response" });

  const composerPanel = composer.createDiv({ cls: "lmsa-chat-composer-panel" });
  const contextPickerPopoverEl = composerPanel.createDiv({ cls: "lmsa-context-picker-popover lmsa-hidden" });
  const contextChipsEl = composerPanel.createDiv({ cls: "lmsa-chat-composer-chips" });
  const contextAddBtnEl = contextChipsEl.createEl("button", {
    cls: "lmsa-chat-composer-add-context-btn",
    attr: { "aria-label": "Add context" },
  });
  setIcon(contextAddBtnEl, "plus");

  const attachmentsEl = composerPanel.createDiv({ cls: "lmsa-chat-composer-attachments" });

  const textareaEl = composerPanel.createEl("textarea", {
    cls: "lmsa-chat-composer-textarea",
    attr: { placeholder: "Ask anything about your writing...", rows: "1" },
  });

  const composerFooter = composerPanel.createDiv({ cls: "lmsa-chat-composer-footer" });

  // The in-flow footer content (capacity + actions) lives in a clipping row so it can
  // never produce a horizontal scrollbar between responsive breakpoints. The popovers
  // below stay direct children of the (positioned) footer, so the clip does not hide them.
  const composerFooterRow = composerFooter.createDiv({ cls: "lmsa-chat-composer-footer-row" });

  // Left cluster: capacity ring + reasoning pill. Grouped so the row keeps its
  // two-child justify-between geometry, and so the right-side indicators keep
  // their measured container-query degradation thresholds (the pill must not
  // add width to the actions row those thresholds were calculated from).
  const composerFooterLeft = composerFooterRow.createDiv({ cls: "lmsa-chat-composer-footer-left" });

  const contextCapacityEl = composerFooterLeft.createDiv({ cls: "lmsa-chat-composer-context-capacity lmsa-hidden" });

  // Same reasoning as the glass filter above: reach the view's own document so the
  // ring's SVG nodes are built in the window the leaf actually lives in.
  const doc = contentEl.ownerDocument;

  const ringSvg = doc.createElementNS(SVG_NS, "svg");
  ringSvg.classList.add("lmsa-context-ring-svg");
  ringSvg.setAttribute("viewBox", "0 0 32 32");
  ringSvg.setAttribute("role", "presentation");

  const trackCircle = doc.createElementNS(SVG_NS, "circle");
  trackCircle.classList.add("lmsa-context-ring-track");
  trackCircle.setAttribute("cx", "16");
  trackCircle.setAttribute("cy", "16");
  trackCircle.setAttribute("r", "12");
  trackCircle.setAttribute("fill", "none");
  trackCircle.setAttribute("stroke-width", "3");

  const fillCircle = doc.createElementNS(SVG_NS, "circle");
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

  // Compact persistent percent next to the ring, so the figure the tooltip carries is not
  // mouse-hover-only. The exact "~Xk / Yk" breakdown stays in the hover tooltip.
  contextCapacityEl.createSpan({ cls: "lmsa-context-ring-label" });

  const reasoningPillEl = composerFooterLeft.createEl("button", {
    cls: "lmsa-chat-composer-reasoning-pill lmsa-hidden",
    attr: { "aria-label": "Reasoning effort" },
  });
  const reasoningPillIcon = reasoningPillEl.createSpan({
    cls: "lmsa-chat-composer-reasoning-pill-icon",
  });
  setIcon(reasoningPillIcon, "brain");
  reasoningPillEl.createSpan({ cls: "lmsa-chat-composer-reasoning-pill-label" });
  // Chevron points up because the level menu opens above the pill.
  const reasoningPillChevron = reasoningPillEl.createSpan({
    cls: "lmsa-chat-composer-reasoning-pill-chevron",
  });
  setIcon(reasoningPillChevron, "chevron-up");

  const composerFooterActions = composerFooterRow.createDiv({ cls: "lmsa-chat-composer-footer-actions" });

  // Overflow trigger for narrow footers: controls that leave the row resurface
  // as sections of its menu (ComposerOverflowMenu). Leftmost in the cluster so
  // it appears where the departed controls used to sit, rather than wedged
  // between the posture pill and send. CSS keeps it hidden while the footer is
  // wide enough to show every control in place.
  const overflowBtnEl = composerFooterActions.createEl("button", {
    cls: "lmsa-chat-composer-overflow-btn",
    attr: { "aria-label": "More options" },
  });
  setIcon(overflowBtnEl, "more-horizontal");

  const toolWrap = composerFooterActions.createDiv({ cls: "lmsa-chat-composer-tool-wrap" });
  const toolUseIndicatorEl = toolWrap.createDiv({ cls: "lmsa-chat-composer-tool-indicator" });
  setIcon(toolUseIndicatorEl, "wrench");
  const knowledgeWrap = composerFooterActions.createDiv({ cls: "lmsa-chat-composer-knowledge-wrap" });
  const knowledgeIndicatorEl = knowledgeWrap.createDiv({ cls: "lmsa-chat-composer-knowledge-indicator" });
  setIcon(knowledgeIndicatorEl, "database");
  const visionIndicatorEl = composerFooterActions.createDiv({ cls: "lmsa-chat-composer-vision-indicator" });
  setIcon(visionIndicatorEl, "eye");
  const posturePillEl = composerFooterActions.createEl("button", {
    cls: "lmsa-chat-composer-posture-pill",
    attr: { "aria-label": "Edit approval" },
  });
  posturePillEl.createSpan({ cls: "lmsa-chat-composer-posture-pill-icon" });
  posturePillEl.createSpan({ cls: "lmsa-chat-composer-posture-pill-label" });
  // Chevron points up because the posture menu opens above the pill.
  const posturePillChevron = posturePillEl.createSpan({
    cls: "lmsa-chat-composer-posture-pill-chevron",
  });
  setIcon(posturePillChevron, "chevron-up");

  const actionBtn = composerFooterActions.createEl("button", {
    cls: "lmsa-chat-composer-send-btn",
  });
  setIcon(actionBtn, "arrow-up");

  // Popovers are children of the footer (not the small wrap divs) so the footer
  // row's overflow clip can't chop them; each one tracks its own chip via CSS
  // anchor positioning (anchor-name on the chip, position-anchor on the popover).
  const toolUsePopoverEl = composerFooter.createDiv({ cls: "lmsa-tool-popover lmsa-hidden" });
  const knowledgePopoverEl = composerFooter.createDiv({ cls: "lmsa-knowledge-popover lmsa-hidden" });
  const reasoningMenuEl = composerFooter.createDiv({ cls: "lmsa-reasoning-menu lmsa-hidden" });
  const postureMenuEl = composerFooter.createDiv({ cls: "lmsa-posture-menu lmsa-hidden" });
  const overflowMenuEl = composerFooter.createDiv({ cls: "lmsa-overflow-menu lmsa-hidden" });

  return {
    rootEl: contentEl,
    messagesPaneEl,
    headerMetaEl: headerMetaLabel,
    newChatBtn,
    historyBtn,
    shellEl: shell,
    messagesEl,
    emptyStateEl,
    emptyCopyEl,
    contextChipsEl,
    textareaEl,
    posturePillEl,
    postureMenuEl,
    toolUseIndicatorEl,
    toolUsePopoverEl,
    knowledgeIndicatorEl,
    knowledgePopoverEl,
    visionIndicatorEl,
    reasoningPillEl,
    reasoningMenuEl,
    overflowBtnEl,
    overflowMenuEl,
    attachmentsEl,
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

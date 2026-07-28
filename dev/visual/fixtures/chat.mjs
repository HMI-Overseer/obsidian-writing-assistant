import { I } from "./icons.mjs";

// A split-view diff hunk (DiffHunkView + SplitDiffRenderer): a context row and a changed row
// (removed left / added right), with a word-level highlight. Used by the edit-review timeline shots.
export const splitHunk = (
  status = "pending",
  {
    location = "Lines 3-4",
    fileName = "Chapter 1.md",
    contextLine = "2",
    contextText = "The sky was gray.",
    changeLine = "3",
    removedText = 'She <span class="lmsa-chat-window-diff-highlight">walked</span> home.',
    addedText = 'She <span class="lmsa-chat-window-diff-highlight">hurried</span> home.',
  } = {},
) =>
  `<div class="lmsa-chat-window-diff-hunk" data-status="${status}">
    <div class="lmsa-chat-window-diff-hunk-header">
      <div class="lmsa-chat-window-diff-hunk-meta">
        <span class="lmsa-chat-window-diff-hunk-location">${location}</span>
        <a class="lmsa-chat-window-diff-hunk-file internal-link" href="#">${fileName}</a>
        <span class="lmsa-chat-window-diff-hunk-confidence">Exact match</span>
      </div>
      <div class="lmsa-chat-window-diff-hunk-actions">
        <div class="lmsa-chat-window-btn-group">
          <button class="lmsa-chat-window-btn-group-item is-active" aria-label="Side-by-side view">${I.columns2}</button>
          <button class="lmsa-chat-window-btn-group-item" aria-label="Unified view">${I.rows2}</button>
        </div>
      </div>
    </div>
    <div class="lmsa-chat-window-diff-hunk-body lmsa-chat-window-diff-hunk-body--split">
      <div class="lmsa-chat-window-diff-row">
        <div class="lmsa-chat-window-diff-side lmsa-chat-window-diff-side--left lmsa-chat-window-diff-line--context">
          <span class="lmsa-chat-window-diff-gutter">${contextLine}</span><span class="lmsa-chat-window-diff-text">${contextText}</span>
        </div>
        <div class="lmsa-chat-window-diff-side lmsa-chat-window-diff-side--right lmsa-chat-window-diff-line--context">
          <span class="lmsa-chat-window-diff-gutter">${contextLine}</span><span class="lmsa-chat-window-diff-text">${contextText}</span>
        </div>
      </div>
      <div class="lmsa-chat-window-diff-row">
        <div class="lmsa-chat-window-diff-side lmsa-chat-window-diff-side--left lmsa-chat-window-diff-line--removed">
          <span class="lmsa-chat-window-diff-gutter">${changeLine}</span><span class="lmsa-chat-window-diff-text">${removedText}</span>
        </div>
        <div class="lmsa-chat-window-diff-side lmsa-chat-window-diff-side--right lmsa-chat-window-diff-line--added">
          <span class="lmsa-chat-window-diff-gutter"></span><span class="lmsa-chat-window-diff-text">${addedText}</span>
        </div>
      </div>
    </div>
  </div>`;

const TOOL_ACTION_SLOT = "<!--lmsa-tool-action-slot-->";

export const turnItem = (
  id,
  type,
  marker,
  body,
  {
    after = true,
    state = "",
    mutating = false,
    fade = false,
    segment = "segment-1",
    action = "",
    presentation = "",
    reviewState = "",
  } = {},
) => {
  const actionHost =
    `<div class="lmsa-assistant-turn-action-host">${action}</div>`;
  const renderedBody =
    type === "tool_call"
      ? body.replace(TOOL_ACTION_SLOT, `${actionHost}${presentation}`)
      : `${body}${actionHost}`;
  return `<li class="lmsa-assistant-turn-item lmsa-assistant-turn-item--${type} has-connector-before${after ? " has-connector-after" : ""}${state ? ` is-${state}` : ""}${reviewState ? ` is-${reviewState}` : ""}${mutating ? " is-mutating" : ""}${fade ? " has-fading-endpoint" : ""}"
    data-item-id="${id}" data-segment-id="${segment}">
    <div class="lmsa-assistant-turn-marker is-${marker}" aria-hidden="true">${
      marker === "thinking"
        ? I.brain
        : marker === "tool"
          ? I.wrench
          : marker === "streaming"
            ? I.ellipsis
            : ""
    }</div>
    <div class="lmsa-assistant-turn-item-body${type === "prose"
      ? " lmsa-assistant-turn-prose lmsa-chat-window-message-content lmsa-chat-window-message-content--markdown"
      : " lmsa-agentic-timeline-step-body"}">${renderedBody}</div>
  </li>`;
};

// One prose item mid-edit. InlineMessageEditor hides the rendered body where it sits and drops a
// transparent textarea into the same grid slot, one per prose item, since an edit session owns the
// whole turn. Tool items are untouched by the session.
export const editingProseItem = (id, marker, text, { after = true, segment = "segment-1" } = {}) =>
  `<li class="lmsa-assistant-turn-item lmsa-assistant-turn-item--prose has-connector-before${after ? " has-connector-after" : ""}"
    data-item-id="${id}" data-segment-id="${segment}">
    <div class="lmsa-assistant-turn-marker is-${marker}" aria-hidden="true">${
      marker === "thinking" ? I.brain : ""
    }</div>
    <textarea class="lmsa-chat-window-inline-editor-textarea lmsa-assistant-turn-item-body" rows="1">${text}</textarea>
    <div class="lmsa-assistant-turn-item-body lmsa-assistant-turn-prose lmsa-chat-window-message-content lmsa-chat-window-message-content--markdown lmsa-hidden">
      <p>${text}</p>
      <div class="lmsa-assistant-turn-action-host"></div>
    </div>
  </li>`;

export const toolTurnBody = (name, detail, state, diagnostics = "") =>
  `<span class="lmsa-assistant-turn-tool-summary is-expandable" role="button" tabindex="0" aria-label="${name}, ${detail}, ${state}" aria-expanded="${diagnostics ? "true" : "false"}">
     <span class="lmsa-agentic-timeline-step-name">${name}</span>
     <span class="lmsa-agentic-timeline-step-detail">${detail}</span>
   </span>
   ${TOOL_ACTION_SLOT}
   ${diagnostics ? `<div class="lmsa-agentic-timeline-step-expand">${diagnostics}</div>` : ""}`;

export const assistantTurn = (items, status = "completed", tail = "") =>
  `<div class="lmsa-chat-window-assistant-turn-host">
    <div class="lmsa-assistant-turn is-${status}">
      <ol class="lmsa-assistant-turn-list">${items}</ol>${tail}
    </div>
  </div>`;

export const assistantBubble = (turn) =>
  `<div class="lmsa-chat-window-message lmsa-chat-window-message--assistant">
    <div class="lmsa-chat-window-message-avatar">${I.bot}</div>
    <div class="lmsa-chat-window-message-column">
      <div class="lmsa-chat-window-message-chrome"><div class="lmsa-chat-window-message-role">Assistant</div></div>
    </div>
    ${turn}
  </div>`;

// Shared footer menu item used by the reasoning / posture / overflow menus (menuItem.ts).
export const menuItem = (label, { icon, selected } = {}) =>
  `<div class="lmsa-footer-menu-item${selected ? " is-selected" : ""}">
    ${icon ? `<span class="lmsa-footer-menu-item-icon">${icon}</span>` : ""}
    <span class="lmsa-footer-menu-item-label">${label}</span>
    ${selected ? `<span class="lmsa-footer-menu-item-check">${I.check}</span>` : ""}
  </div>`;

// Composer footer row (context-capacity ring + reasoning/posture pills + indicators). Shared so the
// at-rest composer, the drag-over state, and the footer-ring shot all render the identical markup.
export const composerFooter = (stopped = false, interacting = false) =>
  `<div class="lmsa-chat-composer-footer${interacting ? " is-interacting" : ""}"><div class="lmsa-chat-composer-footer-row">
  <div class="lmsa-chat-composer-footer-left">
    <div class="lmsa-chat-composer-context-capacity">
      <svg class="lmsa-context-ring-svg" viewBox="0 0 32 32" role="presentation">
        <circle class="lmsa-context-ring-track" cx="16" cy="16" r="12" fill="none" stroke-width="3"/>
        <circle class="lmsa-context-ring-fill" cx="16" cy="16" r="12" fill="none" stroke-width="3"
          stroke-linecap="round" transform="rotate(-90 16 16)" stroke-dasharray="75.4" stroke-dashoffset="45"/>
      </svg><span class="lmsa-context-ring-label">34%</span>
    </div>
    <button class="lmsa-chat-composer-reasoning-pill" aria-label="Reasoning effort">
      <span class="lmsa-chat-composer-reasoning-pill-icon">${I.brain}</span>
      <span class="lmsa-chat-composer-reasoning-pill-label">Medium</span>
      <span class="lmsa-chat-composer-reasoning-pill-chevron">${I.chevronUp}</span>
    </button>
  </div>
  <div class="lmsa-chat-composer-footer-actions">
    <button class="lmsa-chat-composer-overflow-btn" aria-label="More options">${I.more}</button>
    <div class="lmsa-chat-composer-tool-wrap"><div class="lmsa-chat-composer-tool-indicator">${I.wrench}</div></div>
    <div class="lmsa-chat-composer-knowledge-wrap"><div class="lmsa-chat-composer-knowledge-indicator">${I.database}</div></div>
    <div class="lmsa-chat-composer-vision-indicator">${I.eye}</div>
    <button class="lmsa-chat-composer-posture-pill" aria-label="Edit approval">
      <span class="lmsa-chat-composer-posture-pill-icon">${I.hand}</span>
      <span class="lmsa-chat-composer-posture-pill-label">Ask</span>
      <span class="lmsa-chat-composer-posture-pill-chevron">${I.chevronUp}</span>
    </button>
    <button class="lmsa-chat-composer-send-btn${stopped ? " is-stop" : ""}" aria-label="${stopped ? "Stop generation" : "Send message"}">${stopped ? I.square : I.arrowUp}</button>
  </div>
</div></div>`;

// Composer panel. `dragover` toggles the is-dragover state class (drag-drop feedback ring, an outline
// painted outside the box so it exercises compensation #3's reserved-invisible-border case).
export const composerHtml = (dragover = false) =>
  `<div class="lmsa-chat-composer"><div class="lmsa-chat-composer-panel${dragover ? " is-dragover" : ""}">
    <div class="lmsa-chat-composer-normal-body" aria-hidden="false">
      <div class="lmsa-chat-composer-chips">
        <button class="lmsa-chat-composer-add-context-btn" aria-label="Add context">${I.plus}</button>
        <div class="lmsa-chat-composer-chip">
          <span class="lmsa-chat-composer-chip-icon">${I.file}</span>
          <span class="lmsa-chat-composer-chip-label">Draft.md</span>
          <button class="lmsa-chat-composer-chip-remove"><span>${I.x}</span></button>
        </div>
      </div>
      <textarea class="lmsa-chat-composer-textarea" rows="1" placeholder="Ask anything about your writing..."></textarea>
    </div>
    <div class="lmsa-chat-composer-interaction-body" aria-hidden="true" hidden></div>
    ${composerFooter()}
  </div></div>`;

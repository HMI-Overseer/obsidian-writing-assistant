// DOM registry for the visual harness. Each surface reconstructs a component's DOM from its render
// source (the class names the `.ts` emits) so it can be rendered standalone. Faithful, but a model of
// the live DOM, not the live app: add a surface by reading its render `.ts` and mirroring the structure.
import { addedIcon, icon } from "./lucideIcons.mjs";

// Provider brand logomarks: the Simple Icons geometry from src/providers/brandIcons.ts. The plugin
// registers these through addIcon, scaling the upstream 24x24 path onto Obsidian's 0 0 100 100 icon
// viewBox, so the harness applies the same wrapper rather than drawing the raw path.
const VIEWBOX_SCALE = 100 / 24;
const brand = (provider, d) =>
  addedIcon(
    `lmsa-brand-${provider}`,
    `<g transform="scale(${VIEWBOX_SCALE})"><path fill="currentColor" d="${d}"/></g>`,
  );
export const BRAND = {
  anthropic: brand(
    "anthropic",
    "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z",
  ),
  openai: brand(
    "openai",
    "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
  ),
  lmstudio: brand(
    "lmstudio",
    "M5.6 0A5.6 5.6 0 0 0 0 5.6v12.8A5.6 5.6 0 0 0 5.6 24h12.8a5.6 5.6 0 0 0 5.6-5.6V5.6A5.6 5.6 0 0 0 18.4 0zm0 2h12.8A3.6 3.6 0 0 1 22 5.6v12.8a3.6 3.6 0 0 1-3.6 3.6H5.6A3.6 3.6 0 0 1 2 18.4V5.6A3.6 3.6 0 0 1 5.6 2m-.4 2.8a1.2 1.2 0 0 0 0 2.4h10.4a1.2 1.2 0 0 0 0-2.4zm3.2 4a1.2 1.2 0 0 0 0 2.4h10.4a1.2 1.2 0 0 0 0-2.4zm-3.2 4a1.2 1.2 0 0 0 0 2.4h10.4a1.2 1.2 0 0 0 0-2.4zm3.2 4a1.2 1.2 0 0 0 0 2.4h10.4a1.2 1.2 0 0 0 0-2.4z",
  ),
  claudecode: brand(
    "claudecode",
    "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
  ),
};
// The glyphs the surfaces use, keyed as the surfaces refer to them and valued with the name the
// plugin passes to setIcon(). Geometry, the svg-icon class, and Obsidian's legacy name aliasing all
// come from the installed app, so a surface draws what the app draws rather than an approximation.
const ICON_NAMES = {
  chevronDown: "chevron-down",
  chevronUp: "chevron-up",
  chevronLeft: "chevron-left",
  chevronRight: "chevron-right",
  brain: "brain",
  wrench: "wrench",
  database: "database",
  eye: "eye",
  plus: "plus",
  arrowUp: "arrow-up",
  square: "square",
  more: "more-horizontal",
  ellipsis: "ellipsis",
  x: "x",
  file: "file-text",
  fileText: "file-text",
  search: "search",
  refresh: "refresh-cw",
  refreshCw: "refresh-cw",
  check: "check",
  star: "star",
  gear: "settings",
  userRound: "user-round",
  bot: "bot",
  gitBranch: "git-branch",
  copy: "copy",
  pencil: "pencil",
  trash: "trash-2",
  hand: "hand",
  zap: "zap",
  pin: "pin",
  image: "image",
};

export const I = Object.fromEntries(
  Object.entries(ICON_NAMES).map(([key, name]) => [key, icon(name)]),
);

// Harness-only scaffolding. Never mirrors plugin CSS; it only neutralizes anchored/absolute positioning
// so an element screenshot captures the component in flow, and gives popovers a realistic backdrop.
export const SCAFFOLD = `
  html,body{margin:0;padding:0}
  /* content-box so a surface's \`w\` is the width of the component under test, not that width minus
     the stage's own breathing room. Obsidian's app.css sets border-box globally; inheriting it here
     silently narrowed every surface by the padding, which pushed width-sensitive components
     (the composer footer is an @container) into a narrower responsive variant than the one asked for. */
  .lmsa-harness-stage{box-sizing:content-box;padding:28px;display:inline-block;background:var(--background-primary)}
  .lmsa-knowledge-popover,.lmsa-tool-popover,.lmsa-reasoning-menu,.lmsa-posture-menu,
  .lmsa-overflow-menu,.lmsa-model-dropdown,.lmsa-profile-popover,.lmsa-context-picker-popover{
    position:static!important;inset:auto!important;transform:none!important}
  /* No .lmsa-toggle scaffold: the real plugin CSS styles the toggle fully (a bare div with a ::after
     thumb). A stand-in here would double the thumb. Toggles use bare <div class="lmsa-toggle is-enabled">. */
  /* The history drawer is a position:absolute full-pane overlay; render it in flow at a realistic
     width and freeze its fade-in so the screenshot lands on the settled state. */
  .lmsa-history-drawer{position:static!important;inset:auto!important;width:340px;animation:none!important}
  /* Force a hover-revealed toolbar visible for the S2 shot without hovering (opacity:0 at rest). */
  .lmsa-harness-show{opacity:1!important}
  /* S15: a bordered host to prove the closed drawer occupies no space (no sliver, no shove). */
  .lmsa-drawer-probe{position:relative;display:flex;width:340px;height:180px;
    border:1px solid var(--background-modifier-border);border-radius:8px;background:var(--background-primary)}
  .lmsa-drawer-probe-content{margin:auto;color:var(--text-muted);font-size:13px}
  .lmsa-ask-visual-stage{position:relative;height:760px;overflow:hidden}
  .lmsa-ask-visual-stage>.lmsa-chat-composer{position:absolute;right:0;bottom:0;left:0}
  .lmsa-ask-visual-transcript{display:flex;flex-direction:column;gap:18px;padding:28px 24px}
  .lmsa-ask-visual-bubble{max-width:72%;padding:12px 14px;border-radius:14px;
    background:var(--background-secondary);color:var(--text-normal);font-size:14px;line-height:1.5}
  .lmsa-ask-visual-bubble.is-user{align-self:flex-end;background:var(--background-modifier-hover)}
`;

// Wrap component markup in the Obsidian view chain the plugin renders into
// (.workspace-leaf-content[data-type] > .view-content.lmsa-root > .lmsa-shell). ChatView always
// stamps data-posture on the root, and the mode accent keys off it, so the harness sets it too:
// "auto" is what turns --lmsa-mode-accent orange.
export const view = (inner, w, { posture = "ask" } = {}) =>
  `<div class="lmsa-harness-stage"${w ? ` style="width:${w}px"` : ""}>
     <div class="workspace-leaf-content" data-type="writing-assistant-chat">
       <div class="view-content lmsa-root" data-posture="${posture}">
         <div class="lmsa-shell">${inner}</div>
       </div>
     </div></div>`;

const toggle = `<div class="lmsa-knowledge-popover-control"><div class="lmsa-toggle is-enabled"></div></div>`;

// A plain lmsa-toggle (state driven by is-enabled / is-disabled), rendered entirely by the real plugin
// CSS (thumb is a ::after, no child element). Used by the settings surfaces.
const sw = (state = "") => `<div class="lmsa-toggle${state ? " " + state : ""}"></div>`;

// Settings tabs render into the plugin's own settings chain inside Obsidian's modal, NOT the chat root.
// Reconstruct that chain so the panel gradient/backdrop and card cascade are in play. Screenshot the
// panel to frame the cards. (Obsidian-chrome-heavy: these carry the most reconstruction risk.)
const settingsView = (inner, w = 720, tab = "") =>
  `<div class="lmsa-harness-stage" style="width:${w}px">
     <div class="lmsa-settings-root"><div class="lmsa-settings-shell"${tab ? ` data-tab="${tab}"` : ""}><div class="lmsa-settings-stage">
       <div class="lmsa-settings-panel lmsa-ui-panel"><div class="lmsa-settings-content">${inner}</div></div>
     </div></div></div></div>`;

// A settings section card shell (ui.ts createSection). `title` heads it; `body` is the inner markup.
const section = (title, body, extraCls = "", icon = I.gear) =>
  `<div class="lmsa-settings-section lmsa-ui-card${extraCls ? " " + extraCls : ""}">
    <div class="lmsa-settings-section-header">
      <div class="lmsa-settings-section-heading">
        <div class="lmsa-settings-section-icon">${icon}</div>
        <h3 class="lmsa-settings-section-title">${title}</h3>
      </div>
      <div class="lmsa-settings-section-actions"></div>
    </div>
    <div class="lmsa-settings-section-body">${body}</div>
    <div class="lmsa-settings-section-footer"></div>
  </div>`;

// A custom (non-Obsidian) settings row: name + description on the left, a control on the right.
const settingItem = (name, desc, control) =>
  `<div class="lmsa-setting-item">
    <div class="lmsa-setting-item-info">
      <div class="lmsa-setting-item-name">${name}</div>
      <div class="lmsa-setting-item-desc">${desc}</div>
    </div>
    <div class="lmsa-setting-item-control">${control}</div>
  </div>`;

// A split-view diff hunk (DiffHunkView + SplitDiffRenderer): a context row and a changed row
// (removed left / added right), with a word-level highlight. Used by the edit-review timeline shots.
const splitHunk = (status = "pending") =>
  `<div class="lmsa-chat-window-diff-hunk" data-status="${status}">
    <div class="lmsa-chat-window-diff-hunk-header">
      <div class="lmsa-chat-window-diff-hunk-meta">
        <span class="lmsa-chat-window-diff-hunk-location">Lines 3-4</span>
        <a class="lmsa-chat-window-diff-hunk-file internal-link" href="#">Chapter 1.md</a>
        <span class="lmsa-chat-window-diff-hunk-confidence">Exact match</span>
      </div>
      <div class="lmsa-chat-window-diff-hunk-actions">
        <div class="lmsa-chat-window-btn-group">
          <button class="lmsa-chat-window-btn-group-item is-active" aria-label="Side-by-side view">${I.eye}</button>
          <button class="lmsa-chat-window-btn-group-item" aria-label="Unified view">${I.fileText}</button>
        </div>
      </div>
    </div>
    <div class="lmsa-chat-window-diff-hunk-body lmsa-chat-window-diff-hunk-body--split">
      <div class="lmsa-chat-window-diff-row">
        <div class="lmsa-chat-window-diff-side lmsa-chat-window-diff-side--left lmsa-chat-window-diff-line--context">
          <span class="lmsa-chat-window-diff-gutter">2</span><span class="lmsa-chat-window-diff-text">The sky was gray.</span>
        </div>
        <div class="lmsa-chat-window-diff-side lmsa-chat-window-diff-side--right lmsa-chat-window-diff-line--context">
          <span class="lmsa-chat-window-diff-gutter">2</span><span class="lmsa-chat-window-diff-text">The sky was gray.</span>
        </div>
      </div>
      <div class="lmsa-chat-window-diff-row">
        <div class="lmsa-chat-window-diff-side lmsa-chat-window-diff-side--left lmsa-chat-window-diff-line--removed">
          <span class="lmsa-chat-window-diff-gutter">3</span><span class="lmsa-chat-window-diff-text">She <span class="lmsa-chat-window-diff-highlight">walked</span> home.</span>
        </div>
        <div class="lmsa-chat-window-diff-side lmsa-chat-window-diff-side--right lmsa-chat-window-diff-line--added">
          <span class="lmsa-chat-window-diff-gutter"></span><span class="lmsa-chat-window-diff-text">She <span class="lmsa-chat-window-diff-highlight">hurried</span> home.</span>
        </div>
      </div>
    </div>
  </div>`;

const TOOL_ACTION_SLOT = "<!--lmsa-tool-action-slot-->";

const turnItem = (
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
  } = {},
) => {
  const actionHost =
    `<div class="lmsa-assistant-turn-action-host">${action}</div>`;
  const renderedBody =
    type === "tool_call"
      ? body.replace(TOOL_ACTION_SLOT, actionHost)
      : `${body}${actionHost}`;
  return `<li class="lmsa-assistant-turn-item lmsa-assistant-turn-item--${type} has-connector-before${after ? " has-connector-after" : ""}${state ? ` is-${state}` : ""}${mutating ? " is-mutating" : ""}${fade ? " has-fading-endpoint" : ""}"
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

const toolTurnBody = (name, detail, state, diagnostics = "") =>
  `<span class="lmsa-assistant-turn-tool-summary is-expandable" role="button" tabindex="0" aria-label="${name}, ${detail}, ${state}" aria-expanded="${diagnostics ? "true" : "false"}">
     <span class="lmsa-agentic-timeline-step-name">${name}</span>
     <span class="lmsa-agentic-timeline-step-detail">${detail}</span>
   </span>
   ${TOOL_ACTION_SLOT}
   ${diagnostics ? `<div class="lmsa-agentic-timeline-step-expand">${diagnostics}</div>` : ""}`;

const assistantTurn = (items, status = "completed", tail = "") =>
  `<div class="lmsa-chat-window-assistant-turn-host">
    <div class="lmsa-assistant-turn is-${status}">
      <ol class="lmsa-assistant-turn-list">${items}</ol>${tail}
    </div>
  </div>`;

const assistantBubble = (turn) =>
  `<div class="lmsa-chat-window-message lmsa-chat-window-message--assistant">
    <div class="lmsa-chat-window-message-avatar">${I.bot}</div>
    <div class="lmsa-chat-window-message-column">
      <div class="lmsa-chat-window-message-chrome"><div class="lmsa-chat-window-message-role">Assistant</div></div>
    </div>
    ${turn}
  </div>`;

// Shared footer menu item used by the reasoning / posture / overflow menus (menuItem.ts).
const menuItem = (label, { icon, selected } = {}) =>
  `<div class="lmsa-footer-menu-item${selected ? " is-selected" : ""}">
    ${icon ? `<span class="lmsa-footer-menu-item-icon">${icon}</span>` : ""}
    <span class="lmsa-footer-menu-item-label">${label}</span>
    ${selected ? `<span class="lmsa-footer-menu-item-check">${I.check}</span>` : ""}
  </div>`;

// Composer footer row (context-capacity ring + reasoning/posture pills + indicators). Shared so the
// at-rest composer, the drag-over state, and the footer-ring shot all render the identical markup.
const composerFooter = (stopped = false, interacting = false) =>
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
const composerHtml = (dragover = false) =>
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

const askOption = (
  id,
  name,
  label,
  description,
  { checked = false, focused = false, multi = false } = {},
) =>
  `<div class="lmsa-ask-form-option">
    <input class="lmsa-ask-form-option-input" type="${multi ? "checkbox" : "radio"}"
      id="${id}" name="${name}" aria-describedby="${id}-description"${checked ? " checked" : ""}${focused ? " autofocus" : ""}>
    <label class="lmsa-ask-form-option-label" for="${id}">
      <span class="lmsa-ask-form-option-name">${label}</span>
      <span class="lmsa-ask-form-option-description" id="${id}-description">${description}</span>
    </label>
  </div>`;

const askOther = (
  id,
  name,
  { checked = false, multi = false, text = "" } = {},
) =>
  `<div class="lmsa-ask-form-option lmsa-ask-form-other-option${checked ? " is-other-expanded" : ""}">
    <input class="lmsa-ask-form-option-input" type="${multi ? "checkbox" : "radio"}"
      id="${id}" name="${name}"${checked ? " checked" : ""}>
    <label class="lmsa-ask-form-option-label" for="${id}">
      <span class="lmsa-ask-form-option-name">Other</span>
    </label>
    <div class="lmsa-ask-form-other-text"${checked ? "" : " hidden"}>
      <textarea class="lmsa-ask-form-other-textarea" id="${id}-text" aria-label="Other answer" rows="3"
        maxlength="500" placeholder="Type your answer">${text}</textarea>
    </div>
  </div>`;

const askQuestion = ({
  id,
  index,
  total,
  header,
  question,
  multi = false,
  options,
  other,
  complete = false,
  incomplete = false,
}) => ({
  id,
  index,
  total,
  header,
  complete,
  html: (active) =>
    `<div class="lmsa-ask-form-question-panel" id="${id}-panel" role="tabpanel"
      aria-labelledby="${id}-tab"${active ? "" : " hidden"}>
      <fieldset class="lmsa-ask-form-question${complete ? " is-complete" : ""}${incomplete ? " is-incomplete" : ""}">
        <legend class="lmsa-ask-form-legend">
          <span class="lmsa-ask-form-question-meta">
            <span class="lmsa-ask-form-question-number">Question ${index} of ${total}</span>
          </span>
          <span class="lmsa-ask-form-question-text">${question}</span>
        </legend>
        <div class="lmsa-ask-form-options">
          ${options.map((option, optionIndex) => askOption(
            `${id}-o${optionIndex}`,
            id,
            option.label,
            option.description,
            { checked: option.checked, focused: option.focused, multi },
          )).join("")}
          ${askOther(`${id}-other`, id, { ...other, multi })}
        </div>
      </fieldset>
    </div>`,
});

const askForm = (
  questions,
  {
    ready = false,
    showError = false,
    activeIndex = 0,
    collapsed = false,
  } = {},
) => {
  const tabs = questions.map((question, questionIndex) => {
    const active = questionIndex === activeIndex;
    return `<button class="lmsa-ask-form-tab${active ? " is-active" : ""}${question.complete ? " is-complete" : ""}"
      id="${question.id}-tab" type="button" role="tab" aria-controls="${question.id}-panel"
      aria-selected="${active ? "true" : "false"}" tabindex="${active ? "0" : "-1"}"
      aria-label="Question ${question.index} of ${question.total}: ${question.header}. ${question.complete ? "Answered" : "Unanswered"}">
      <span class="lmsa-ask-form-tab-number" aria-hidden="true">${question.index}</span>
      <span class="lmsa-ask-form-tab-label" aria-hidden="true">${question.header}</span>
      <span class="lmsa-ask-form-tab-status" aria-hidden="true"></span>
    </button>`;
  }).join("");
  const panels = questions
    .map((question, questionIndex) => question.html(questionIndex === activeIndex))
    .join("");
  return `<form class="lmsa-ask-form${collapsed ? " is-collapsed" : ""}">
    <div class="lmsa-ask-form-toolbar">
      <div class="lmsa-ask-form-tabs" role="tablist" aria-label="Questions">${tabs}</div>
      <button class="lmsa-ask-form-collapse" type="button"
        aria-label="${collapsed ? "Expand questions" : "Minimize questions"}"
        aria-controls="ask-visual-body" aria-expanded="${collapsed ? "false" : "true"}">
        ${collapsed ? I.chevronUp : I.chevronDown}
      </button>
    </div>
    <div class="lmsa-ask-form-body" id="ask-visual-body" aria-hidden="${collapsed ? "true" : "false"}"${collapsed ? " inert" : ""}>
      <div class="lmsa-ask-form-questions">${panels}</div>
      <div class="lmsa-ask-form-error${showError ? "" : " lmsa-hidden"}" role="alert">Answer every question before submitting.</div>
      <div class="lmsa-ask-form-actions">
        <button class="lmsa-ui-btn lmsa-ui-btn-primary lmsa-ask-form-submit" type="submit"${ready ? "" : " disabled"}>Submit answers</button>
      </div>
    </div>
  </form>`;
};

const askComposerHtml = (questions, state) =>
  `<div class="lmsa-chat-composer">
    <div class="lmsa-chat-composer-interaction-body${state?.collapsed ? " is-collapsed" : ""}" aria-hidden="false">
      ${askForm(questions, state)}
    </div>
    <div class="lmsa-chat-composer-panel is-interacting is-ask-interaction">
    <div class="lmsa-chat-composer-normal-body" aria-hidden="true" inert>
      <textarea class="lmsa-chat-composer-textarea" rows="1" disabled>An exact draft remains mounted here.</textarea>
    </div>
    ${composerFooter(true, true)}
  </div></div>`;

const askStageHtml = (questions, state) =>
  `<div class="lmsa-ask-visual-stage">
    <div class="lmsa-ask-visual-transcript">
      <div class="lmsa-ask-visual-bubble is-user">Help me decide how this handoff should be structured.</div>
      <div class="lmsa-ask-visual-bubble">I need a few choices before I can finish the recommendation.</div>
      <div class="lmsa-ask-visual-bubble is-user">Keep the answer practical and easy to review.</div>
      <div class="lmsa-ask-visual-bubble">The form opens over this conversation without moving the composer.</div>
    </div>
    ${askComposerHtml(questions, state)}
  </div>`;

const singleIncompleteQuestion = askQuestion({
  id: "ask-single-q0",
  index: 1,
  total: 1,
  header: "Output",
  question: "Which output shape should I optimize for?",
  options: [
    { label: "Concise", description: "A short result focused on the final recommendation." },
    { label: "Detailed", description: "A fuller result with rationale, trade-offs, and examples." },
  ],
  other: {},
  incomplete: true,
});

const otherReadyQuestion = askQuestion({
  id: "ask-other-q0",
  index: 1,
  total: 1,
  header: "Coverage",
  question: "Which areas should I cover in the handoff?",
  multi: true,
  options: [
    {
      label: "Testing",
      description: "Cover automated behavior and regression evidence.",
      checked: true,
    },
    {
      label: "Migration",
      description: "Explain compatibility and rollout concerns.",
    },
  ],
  other: {
    checked: true,
    text: "Include keyboard-only failure modes and provider recovery.",
  },
  complete: true,
});

const mixedReadyQuestions = [
  askQuestion({
    id: "ask-mixed-q0",
    index: 1,
    total: 4,
    header: "Output",
    question: "Which output shape should I optimize for while keeping the final result easy to scan?",
    options: [
      { label: "Concise", description: "Lead with the recommendation and keep supporting detail compact." },
      {
        label: "Detailed",
        description: "Include rationale, trade-offs, implementation notes, and examples.",
        checked: true,
        focused: true,
      },
    ],
    other: {},
    complete: true,
  }),
  askQuestion({
    id: "ask-mixed-q1",
    index: 2,
    total: 4,
    header: "Coverage",
    question: "Which areas need explicit treatment in the implementation handoff?",
    multi: true,
    options: [
      { label: "Testing", description: "Cover automated behavior and regression evidence.", checked: true },
      { label: "Migration", description: "Explain compatibility and rollout concerns." },
      { label: "Accessibility", description: "Cover keyboard, focus, labels, and narrow layouts.", checked: true },
    ],
    other: {
      checked: true,
      text: "Include provider-failure recovery and submit/abort races.",
    },
    complete: true,
  }),
  askQuestion({
    id: "ask-mixed-q2",
    index: 3,
    total: 4,
    header: "Audience",
    question: "Who should the explanation assume will maintain this feature after the initial release?",
    options: [
      { label: "Plugin maintainer", description: "Assume familiarity with this repository and Obsidian APIs.", checked: true },
      { label: "New contributor", description: "Explain the architecture and local conventions from first principles." },
    ],
    other: {},
    complete: true,
  }),
  askQuestion({
    id: "ask-mixed-q3",
    index: 4,
    total: 4,
    header: "Emphasis",
    question: "Which qualities should be most visible in the final recommendation?",
    multi: true,
    options: [
      { label: "Readability", description: "Prefer code that is clear on first encounter.", checked: true },
      { label: "Development speed", description: "Keep future changes localized and low-boilerplate.", checked: true },
      { label: "Scalability", description: "Preserve a clean seam for later interaction kinds." },
    ],
    other: {},
    complete: true,
  }),
];

const fillToCodePoints = (prefix, limit, glyph) =>
  prefix + glyph.repeat(limit - [...prefix].length);

const maximumContractQuestions = Array.from({ length: 4 }, (_, questionIndex) => {
  const questionNumber = questionIndex + 1;
  return askQuestion({
    id: `ask-maximum-q${questionIndex}`,
    index: questionNumber,
    total: 4,
    header: fillToCodePoints(`Q${questionNumber} boundary!`, 12, "!"),
    question: fillToCodePoints(
      `Question ${questionNumber}: maximum valid model copy `,
      300,
      "q",
    ),
    multi: questionIndex % 2 === 1,
    options: Array.from({ length: 4 }, (_, optionIndex) => ({
      label: fillToCodePoints(
        `Q${questionNumber} option ${optionIndex + 1} `,
        40,
        "L",
      ),
      description: fillToCodePoints(
        `Question ${questionNumber}, option ${optionIndex + 1}: `,
        200,
        "d",
      ),
      checked: optionIndex === 0,
    })),
    other: questionIndex === 0
      ? {
          checked: true,
          text: fillToCodePoints("Maximum custom answer: ", 500, "a"),
        }
      : {},
    complete: true,
  });
});

const memoryRow = (name, type, desc, on = true, confirming = false) =>
  `<tr class="${on ? "" : "is-off"}${confirming ? " is-confirming-delete" : ""}">
    <td class="lmsa-memory-col-switch">${sw(on ? "is-enabled" : "")}</td>
    <td class="lmsa-memory-cell-name">${name}</td>
    <td><span class="lmsa-memory-badge is-${type}">${type === "rule" ? "Rule" : "Context"}</span></td>
    <td class="lmsa-memory-cell-desc">${desc}</td>
    <td class="lmsa-memory-col-actions">${
      confirming
        ? `<button class="lmsa-ui-compact-btn lmsa-ui-compact-btn-danger">Delete</button>
           <button class="lmsa-ui-compact-btn lmsa-ui-compact-btn-secondary">Cancel</button>`
        : `<button class="lmsa-ui-btn lmsa-ui-btn-secondary lmsa-memory-icon-btn" aria-label="Edit">${I.pencil}</button>
           <button class="lmsa-ui-btn lmsa-btn-danger lmsa-memory-icon-btn" aria-label="Delete">${I.trash}</button>`
    }</td>
  </tr>`;

const memoryTable = (rows) =>
  `<div class="lmsa-memory-capacity">
    <div class="lmsa-memory-capacity-header">
      <span class="lmsa-memory-capacity-label">Index budget (advisory)</span>
      <span class="lmsa-memory-capacity-value">~180 of 3.0k tokens (6%)</span>
    </div>
    <div class="lmsa-index-progress-bar"><div class="lmsa-index-progress-fill" style="width:6%"></div></div>
  </div>
  <div class="lmsa-memory-list"><table class="lmsa-memory-table">
    <thead><tr>
      <th class="lmsa-memory-col-switch"></th><th>Name</th><th>Type</th><th>Description</th>
      <th class="lmsa-memory-col-actions"></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
`;

// Feature off: the table is not rendered at all, the body carries the message.
const memoryOffState = () =>
  `<div class="lmsa-memory-list"><div class="lmsa-memory-off-state">
    <div class="lmsa-memory-off-title">Memories are off</div>
    <div class="lmsa-memory-off-hint">Enable memories above to edit, delete, add and use these entries.</div>
  </div></div>`;

export const SURFACES = {
  // Composer at rest, wide enough that every footer control shows in place.
  composer: {
    w: 600,
    shot: ".lmsa-chat-composer",
    html: view(composerHtml(), 600),
  },

  // Phase 2 ask interaction: one unanswered radio question. The local validation
  // message and disabled explicit submit action show the incomplete state.
  askSingleIncomplete: {
    w: 600,
    shot: ".lmsa-ask-visual-stage",
    html: view(
      askStageHtml([singleIncompleteQuestion], {
        ready: false,
        showError: true,
      }),
      600,
    ),
  },

  // One ready multi-select question with the application-owned Other control
  // expanded, populated, and included alongside a model-authored choice.
  askOtherReady: {
    w: 600,
    shot: ".lmsa-ask-visual-stage",
    html: view(
      askStageHtml([otherReadyQuestion], { ready: true }),
      600,
    ),
  },

  // Four ready question tabs mixing radios, checkboxes, long copy, and an
  // application-owned Other textarea with user text.
  askMixedReady: {
    w: 600,
    shot: ".lmsa-ask-visual-stage",
    html: view(
      askStageHtml(mixedReadyQuestions, { ready: true }),
      600,
    ),
  },

  // The same four-question drawer at narrow sidebar width. Its active panel stays
  // inside the bounded scroll region while navigation and Stop remain reachable.
  askMixedNarrow: {
    w: 320,
    shot: ".lmsa-ask-visual-stage",
    html: view(
      askStageHtml(mixedReadyQuestions, { ready: true }),
      320,
    ),
  },

  // Exact contract maximum: four questions, four options each, maximum model copy,
  // and one 500-code-point Other answer.
  askMaximumContract: {
    w: 600,
    shot: ".lmsa-ask-visual-stage",
    html: view(
      askStageHtml(maximumContractQuestions, { ready: true }),
      600,
    ),
  },

  // Exact contract maximum at the narrow sidebar width.
  askMaximumContractNarrow: {
    w: 320,
    shot: ".lmsa-ask-visual-stage",
    html: view(
      askStageHtml(maximumContractQuestions, { ready: true }),
      320,
    ),
  },

  // The minimized drawer keeps its tab state and restore control while exposing
  // the transcript behind it.
  askMixedMinimized: {
    w: 600,
    shot: ".lmsa-ask-visual-stage",
    html: view(
      askStageHtml(mixedReadyQuestions, {
        ready: true,
        collapsed: true,
      }),
      600,
    ),
  },

  // Empty state (createChatLayout.ts + EmptyStateCarousel.ts): the writing-prompt carousel. The controller
  // slides the track via --lmsa-carousel-index and reveals the nav on hover; the harness renders a static
  // frame at index 0 with the nav forced visible (lmsa-harness-show) so its placement can be checked.
  emptyState: {
    w: 460,
    shot: ".lmsa-messages-pane",
    html: view(
      `<div class="lmsa-messages-pane" style="position:relative;width:412px;height:540px;flex:none">
        <div class="lmsa-empty-view">
          <div class="lmsa-empty-title">Start a conversation</div>
          <div class="lmsa-empty-copy">
            <div class="lmsa-empty-carousel">
              <div class="lmsa-empty-carousel-viewport">
                <div class="lmsa-empty-carousel-track">
                  <div class="lmsa-empty-carousel-slide">Ask a question, paste a passage, or run a quick command on your draft.</div>
                  <div class="lmsa-empty-carousel-slide">Select a line in your note and ask for a few ways to phrase it.</div>
                  <div class="lmsa-empty-carousel-slide">Paste a paragraph and I'll tighten it without losing your voice.</div>
                  <div class="lmsa-empty-carousel-slide">Describe where a scene is headed and we'll find the next line together.</div>
                </div>
              </div>
              <button class="lmsa-empty-carousel-nav lmsa-empty-carousel-nav--prev lmsa-harness-show" aria-label="Previous prompt">${I.chevronLeft}</button>
              <button class="lmsa-empty-carousel-nav lmsa-empty-carousel-nav--next lmsa-harness-show" aria-label="Next prompt">${I.chevronRight}</button>
            </div>
          </div>
        </div>
      </div>`,
      460,
    ),
  },

  // S4: composer while a vault note is dragged over it. Exercises the drag-outline trick that depends
  // on the reserved invisible border (compensation #3). The dashed ring must appear with no 1px shift.
  composerDragOver: {
    w: 600,
    shot: ".lmsa-chat-composer",
    html: view(composerHtml(true), 600),
  },

  // S10: footer framed on its own so the context-capacity ring geometry/color is easy to A/B.
  footerRing: {
    w: 600,
    shot: ".lmsa-chat-composer-footer",
    html: view(composerHtml(), 600),
  },

  // Chat model dropdown: search + provider rail (four brand tints) + item list with status dots.
  modelDropdown: {
    w: 460,
    shot: ".lmsa-model-dropdown",
    html: view(
      `<div class="lmsa-model-dropdown">
        <div class="lmsa-model-dropdown-search">
          <span class="lmsa-model-dropdown-search-icon">${I.search}</span>
          <input class="lmsa-model-dropdown-search-input" placeholder="Search models" />
          <button class="lmsa-model-dropdown-refresh">${I.refresh}</button>
        </div>
        <div class="lmsa-model-dropdown-body">
          <div class="lmsa-provider-rail">
            <div class="lmsa-provider-rail-item lmsa-brand-tint-anthropic is-active">${BRAND.anthropic}</div>
            <div class="lmsa-provider-rail-item lmsa-brand-tint-openai">${BRAND.openai}</div>
            <div class="lmsa-provider-rail-item lmsa-brand-tint-lmstudio">${BRAND.lmstudio}</div>
            <div class="lmsa-provider-rail-item lmsa-brand-tint-claudecode">${BRAND.claudecode}</div>
          </div>
          <div class="lmsa-model-dropdown-list">
            <div class="lmsa-model-dropdown-item is-active">
              <span class="lmsa-model-dropdown-check">${I.check}</span>
              <div class="lmsa-model-dropdown-copy">
                <span class="lmsa-model-dropdown-name">claude-opus-4-8</span>
                <span class="lmsa-model-dropdown-provider">Anthropic</span>
              </div>
              <span class="lmsa-model-dropdown-state is-cloud"></span>
              <span class="lmsa-model-dropdown-star is-faved">${I.star}</span>
            </div>
            <div class="lmsa-model-dropdown-item">
              <span class="lmsa-model-dropdown-check"></span>
              <div class="lmsa-model-dropdown-copy">
                <span class="lmsa-model-dropdown-name">qwen2.5-coder-7b</span>
                <span class="lmsa-model-dropdown-provider">LM Studio</span>
              </div>
              <span class="lmsa-model-dropdown-state is-loaded"></span>
              <span class="lmsa-model-dropdown-star">${I.star}</span>
            </div>
            <div class="lmsa-model-dropdown-item">
              <span class="lmsa-model-dropdown-check"></span>
              <div class="lmsa-model-dropdown-copy">
                <span class="lmsa-model-dropdown-name">gemma-3-12b</span>
                <span class="lmsa-model-dropdown-provider">LM Studio</span>
              </div>
              <span class="lmsa-model-dropdown-state is-unloaded"></span>
              <span class="lmsa-model-dropdown-star">${I.star}</span>
            </div>
          </div>
        </div>
      </div>`,
      460,
    ),
  },

  // Knowledge popover (composer): sections, toggles, and the shared model-selector trigger.
  knowledgePopover: {
    w: 360,
    shot: ".lmsa-knowledge-popover",
    html: view(
      `<div class="lmsa-knowledge-popover">
        <div class="lmsa-knowledge-popover-title">Knowledge</div>
        <div class="lmsa-knowledge-popover-body">
          <div class="lmsa-knowledge-popover-section">
            <div class="lmsa-knowledge-popover-row">
              <span class="lmsa-knowledge-popover-label">Vault retrieval</span>${toggle}
            </div>
            <div class="lmsa-knowledge-popover-model-wrap"><div class="lmsa-settings-model-selector-wrap">
              <div class="lmsa-settings-model-selector is-active">
                <span class="lmsa-model-selector-status is-cloud"></span>
                <span class="lmsa-settings-model-selector-label">text-embedding-3-large</span>
                <span class="lmsa-settings-model-selector-chevron">${I.chevronDown}</span>
              </div>
            </div></div>
            <div class="lmsa-knowledge-popover-status-row">
              <span class="lmsa-knowledge-popover-status">Indexed 1,234 chunks across 87 notes.</span>
              <button class="lmsa-knowledge-popover-action-btn">${I.gear}</button>
            </div>
          </div>
          <div class="lmsa-knowledge-popover-section">
            <div class="lmsa-knowledge-popover-row">
              <span class="lmsa-knowledge-popover-label">Knowledge graph</span>${toggle}
            </div>
            <span class="lmsa-knowledge-popover-status">Graph disabled.</span>
            <span class="lmsa-knowledge-popover-hint">Configure in settings.</span>
          </div>
          <div class="lmsa-knowledge-popover-section">
            <div class="lmsa-knowledge-popover-row">
              <span class="lmsa-knowledge-popover-label">Memories</span>${toggle}
            </div>
            <span class="lmsa-knowledge-popover-status">2 enabled of 5, ~180 tokens</span>
            <span class="lmsa-knowledge-popover-hint">Manage memories in plugin settings.</span>
          </div>
        </div>
      </div>`,
      360,
    ),
  },

  // S1: transcript at rest, a user bubble + an assistant bubble carrying a fenced code block. Toolbars
  // are present but at opacity:0 (their at-rest state), so no is-hover / harness-show here.
  transcript: {
    w: 620,
    shot: ".lmsa-chat-window-messages",
    html: view(
      `<div class="lmsa-messages-pane"><div class="lmsa-chat-window-messages">
        <div class="lmsa-chat-window-message lmsa-chat-window-message--user">
          <div class="lmsa-chat-window-message-avatar">${I.userRound}</div>
          <div class="lmsa-chat-window-message-column">
            <div class="lmsa-chat-window-message-chrome"><div class="lmsa-chat-window-message-role">You</div></div>
            <div class="lmsa-chat-window-message-body lmsa-ui-card">
              <div class="lmsa-chat-window-message-content lmsa-chat-window-message-content--markdown">
                <p>Show me a Python hello world.</p>
              </div>
            </div>
          </div>
        </div>
        ${assistantBubble(
          assistantTurn(
            turnItem(
              "prose-1",
              "prose",
              "iconless",
              `<p>Here you go:</p>
               <div class="lmsa-md-codeblock">
                 <div class="lmsa-md-codeblock-header">
                   <span class="lmsa-md-codeblock-language">python</span>
                   <button type="button" class="lmsa-md-codeblock-copy">Copy</button>
                 </div>
                 <pre class="lmsa-md-codeblock-pre"><code class="language-python">print("hello world")</code></pre>
               </div>`,
              { after: false, fade: true },
            ),
          ),
        )}
      </div></div>`,
      620,
    ),
  },

  // S2: hover-revealed bubble toolbar (version nav + action buttons). Forced visible via harness-show.
  // Gate: the icon buttons carry no Obsidian button chrome (the .lmsa-ui-icon-btn !important override).
  bubbleToolbar: {
    w: 360,
    shot: ".lmsa-chat-window-bubble-toolbar",
    html: view(
      `<div class="lmsa-chat-window-message lmsa-chat-window-message--assistant">
        <div class="lmsa-chat-window-bubble-toolbar lmsa-harness-show">
          <div class="lmsa-chat-window-version-nav">
            <button class="lmsa-chat-window-version-prev" aria-label="Previous version" type="button">${I.chevronLeft}</button>
            <span class="lmsa-chat-window-version-indicator">2/2</span>
            <button class="lmsa-chat-window-version-next" aria-label="Next version" type="button" disabled>${I.chevronRight}</button>
          </div>
          <div class="lmsa-chat-window-message-actions">
            <button class="lmsa-chat-window-action-btn" data-action="regenerate" aria-label="Regenerate response" type="button">${I.refreshCw}</button>
            <button class="lmsa-chat-window-action-btn" data-action="branch" aria-label="Branch after this" type="button">${I.gitBranch}</button>
            <button class="lmsa-chat-window-action-btn" data-action="copy" aria-label="Copy message" type="button">${I.copy}</button>
            <button class="lmsa-chat-window-action-btn" data-action="edit" aria-label="Edit message" type="button">${I.pencil}</button>
            <button class="lmsa-chat-window-action-btn" data-action="delete" aria-label="Delete message" type="button">${I.trash}</button>
          </div>
        </div>
      </div>`,
      360,
    ),
  },

  // S5: reasoning pill menu open. Reasoning rows have no icon; the selected row carries a trailing check.
  reasoningMenu: {
    w: 260,
    shot: ".lmsa-reasoning-menu",
    html: view(
      `<div class="lmsa-reasoning-menu">
        ${menuItem("Default")}
        ${menuItem("Low")}
        ${menuItem("Medium")}
        ${menuItem("High", { selected: true })}
      </div>`,
      260,
    ),
  },

  // S6: posture pill menu open. Posture rows carry a leading icon; one selected.
  postureMenu: {
    w: 260,
    shot: ".lmsa-posture-menu",
    html: view(
      `<div class="lmsa-posture-menu">
        ${menuItem("Ask before edits", { icon: I.hand, selected: true })}
        ${menuItem("Edit automatically", { icon: I.zap })}
      </div>`,
      260,
    ),
  },

  // S7: context (active-note) popover open, menu view. Row 1 attached (check + is-attach-disabled) with
  // an active auto-attach pin; plus the vault and image rows.
  contextPopover: {
    w: 320,
    shot: ".lmsa-context-picker-popover",
    html: view(
      `<div class="lmsa-context-picker-popover">
        <div class="lmsa-context-picker-row is-attach-disabled">
          <div class="lmsa-context-picker-row-main">
            <span class="lmsa-context-picker-row-icon">${I.fileText}</span>
            <span class="lmsa-context-picker-row-label">
              <span class="lmsa-context-picker-row-title">Add current note</span>
              <span class="lmsa-context-picker-row-hint">My Note.md</span>
            </span>
            <span class="lmsa-context-picker-row-check">${I.check}</span>
          </div>
          <button class="lmsa-context-picker-pin is-active" type="button" aria-pressed="true">${I.pin}</button>
        </div>
        <div class="lmsa-context-picker-row">
          <span class="lmsa-context-picker-row-icon">${I.search}</span>
          <span class="lmsa-context-picker-row-label">
            <span class="lmsa-context-picker-row-title">Add note from vault</span>
          </span>
        </div>
        <div class="lmsa-context-picker-row">
          <span class="lmsa-context-picker-row-icon">${I.image}</span>
          <span class="lmsa-context-picker-row-label">
            <span class="lmsa-context-picker-row-title">Attach image</span>
          </span>
        </div>
      </div>`,
      320,
    ),
  },

  // S9: tool-use popover open, agentic mode on.
  toolPopover: {
    w: 320,
    shot: ".lmsa-tool-popover",
    html: view(
      `<div class="lmsa-tool-popover">
        <div class="lmsa-tool-popover-title">Tool use</div>
        <div class="lmsa-tool-popover-body">
          <div class="lmsa-tool-popover-section">
            <div class="lmsa-tool-popover-row">
              <span class="lmsa-tool-popover-label">Agentic mode</span>
              <div class="lmsa-tool-popover-control">
                <div class="lmsa-toggle is-enabled" role="switch" aria-checked="true" tabindex="0"></div>
              </div>
            </div>
            <span class="lmsa-tool-popover-status">Vault search and edit tools available</span>
          </div>
        </div>
      </div>`,
      320,
    ),
  },

  // S11: composer overflow menu open (narrow-width control). Every section is in the DOM.
  overflowMenu: {
    w: 260,
    shot: ".lmsa-overflow-menu",
    html: view(
      `<div class="lmsa-overflow-menu">
        <div class="lmsa-overflow-menu-section lmsa-overflow-section-reasoning">
          <div class="lmsa-overflow-menu-heading">Reasoning</div>
          ${menuItem("Default")}
          ${menuItem("High", { selected: true })}
        </div>
        <div class="lmsa-overflow-menu-section lmsa-overflow-section-vision">
          <div class="lmsa-overflow-menu-status is-active">
            <span class="lmsa-overflow-menu-status-icon">${I.eye}</span>
            <span class="lmsa-overflow-menu-status-label">Vision supported</span>
          </div>
        </div>
        <div class="lmsa-overflow-menu-section lmsa-overflow-section-knowledge">
          ${menuItem("Knowledge…", { icon: I.database })}
        </div>
        <div class="lmsa-overflow-menu-section lmsa-overflow-section-tools">
          ${menuItem("Tools…", { icon: I.wrench })}
        </div>
        <div class="lmsa-overflow-menu-section lmsa-overflow-section-posture">
          <div class="lmsa-overflow-menu-heading">Edit approval</div>
          ${menuItem("Ask before edits", { icon: I.hand, selected: true })}
          ${menuItem("Edit automatically", { icon: I.zap })}
        </div>
      </div>`,
      260,
    ),
  },

  // S13: profile settings popover, a non-default profile (Anthropic) so sampling + reasoning + cache show.
  profilePopover: {
    w: 460,
    shot: ".lmsa-profile-popover",
    html: view(
      `<div class="lmsa-profile-popover">
        <div class="lmsa-profile-popover-layout">
          <div class="lmsa-provider-rail">
            <div class="lmsa-provider-rail-item lmsa-brand-tint-anthropic is-active" title="Anthropic">${BRAND.anthropic}</div>
            <div class="lmsa-provider-rail-item lmsa-brand-tint-lmstudio" title="LM Studio">${BRAND.lmstudio}</div>
            <div class="lmsa-provider-rail-divider"></div>
            <div class="lmsa-provider-rail-item lmsa-brand-tint-openai is-disabled" title="OpenAI">${BRAND.openai}</div>
          </div>
          <div class="lmsa-profile-popover-content">
            <div class="lmsa-profile-popover-title">Model parameters<span class="lmsa-profile-popover-subtitle">Claude Sonnet 4.5</span></div>
            <div class="lmsa-profile-selector-row">
              <div class="lmsa-profile-trigger">
                <span class="lmsa-profile-trigger-label">Creative</span>
                <span class="lmsa-profile-trigger-chevron">${I.chevronDown}</span>
              </div>
              <div class="lmsa-profile-menu lmsa-hidden"></div>
              <div class="lmsa-profile-selector-actions">
                <button class="lmsa-profile-action-btn" aria-label="Create profile">${I.plus}</button>
                <button class="lmsa-profile-action-btn lmsa-profile-action-btn--danger" aria-label="Delete profile">${I.trash}</button>
              </div>
            </div>
            <div class="lmsa-profile-popover-body">
              <div class="lmsa-profile-popover-section">
                <div class="lmsa-profile-popover-section-title">Sampling</div>
                <div class="lmsa-params-body">
                  <div class="lmsa-params-section">
                    <label class="lmsa-params-label">System prompt</label>
                    <textarea class="lmsa-params-textarea" rows="4">You are a co-writer.</textarea>
                  </div>
                  <div class="lmsa-params-section">
                    <label class="lmsa-params-label">Temperature</label>
                    <div class="lmsa-params-slider-row">
                      <input class="lmsa-params-slider" type="range" min="0" max="1" step="0.05" value="0.70">
                      <span class="lmsa-params-slider-value">0.70</span>
                    </div>
                  </div>
                  <div class="lmsa-params-section">
                    <div class="lmsa-params-toggle-row">
                      <input class="lmsa-params-toggle" type="checkbox" checked>
                      <label class="lmsa-params-label">Max tokens</label>
                    </div>
                    <div class="lmsa-params-input-row">
                      <input class="lmsa-params-number-input" type="number" min="1" max="32768" step="1" value="2000">
                    </div>
                  </div>
                </div>
              </div>
              <div class="lmsa-profile-popover-section lmsa-model-reasoning-section">
                <div class="lmsa-profile-popover-section-title">Reasoning</div>
                <div class="lmsa-params-body">
                  <div class="lmsa-params-section">
                    <div class="lmsa-params-toggle-row">
                      <input class="lmsa-params-toggle" type="checkbox">
                      <label class="lmsa-params-label">Reasoning</label>
                    </div>
                    <div class="lmsa-params-input-row is-disabled">
                      <select class="lmsa-params-select" disabled>
                        <option>Low</option><option>Medium</option><option>High</option>
                      </select>
                    </div>
                  </div>
                </div>
                <span class="lmsa-profile-popover-hint">Remembered per model, off means the model default.</span>
              </div>
              <div class="lmsa-profile-popover-section">
                <div class="lmsa-profile-popover-section-title">Prompt caching</div>
                <div class="lmsa-profile-popover-row">
                  <span class="lmsa-profile-popover-label">Enable caching</span>
                  <div class="lmsa-profile-popover-control"><input type="checkbox" class="lmsa-profile-toggle" checked></div>
                </div>
                <div class="lmsa-profile-popover-row">
                  <span class="lmsa-profile-popover-label">Cache TTL</span>
                  <div class="lmsa-profile-popover-control">
                    <select class="lmsa-profile-ttl-select"><option>5 min (default)</option><option>1 hour (2x write cost)</option></select>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>`,
      460,
    ),
  },

  // S14: history drawer open (active + normal rows, search, header). Row actions are opacity:0 until
  // hover; that is the correct at-rest look.
  historyDrawer: {
    w: 400,
    shot: ".lmsa-history-drawer",
    html: view(
      `<div class="lmsa-history-drawer is-open">
        <div class="lmsa-history-header">
          <div class="lmsa-history-title-group">
            <span class="lmsa-history-title">Chat history</span>
            <span class="lmsa-history-count">3 / 50</span>
          </div>
          <div class="lmsa-history-header-actions">
            <button class="lmsa-history-btn lmsa-ui-icon-btn" aria-label="New conversation">${I.plus}</button>
          </div>
        </div>
        <div class="lmsa-history-search">
          <input class="lmsa-history-search-input" type="text" placeholder="Search conversations...">
        </div>
        <div class="lmsa-history-list">
          <div class="lmsa-history-item lmsa-ui-list-item is-active">
            <div class="lmsa-history-item-body">
              <div class="lmsa-history-item-title">Chapter 3 revisions</div>
              <div class="lmsa-history-item-meta">2h ago · 14 msgs · Claude Sonnet 4.5</div>
            </div>
            <button class="lmsa-history-btn lmsa-history-rename-btn lmsa-ui-icon-btn" aria-label="Rename conversation">${I.pencil}</button>
            <div class="lmsa-history-item-delete-area">
              <button class="lmsa-history-btn lmsa-history-trash-btn lmsa-ui-icon-btn" aria-label="Delete conversation">${I.trash}</button>
            </div>
          </div>
          <div class="lmsa-history-item lmsa-ui-list-item">
            <div class="lmsa-history-item-body">
              <div class="lmsa-history-item-title">Character arc brainstorm</div>
              <div class="lmsa-history-item-meta">Yesterday · 8 msgs · LM Studio</div>
            </div>
            <button class="lmsa-history-btn lmsa-history-rename-btn lmsa-ui-icon-btn" aria-label="Rename conversation">${I.pencil}</button>
            <div class="lmsa-history-item-delete-area">
              <button class="lmsa-history-btn lmsa-history-trash-btn lmsa-ui-icon-btn" aria-label="Delete conversation">${I.trash}</button>
            </div>
          </div>
          <div class="lmsa-history-item lmsa-ui-list-item">
            <div class="lmsa-history-item-body">
              <div class="lmsa-history-item-title">New conversation</div>
              <div class="lmsa-history-item-meta">3d ago · 1 msg</div>
            </div>
            <button class="lmsa-history-btn lmsa-history-rename-btn lmsa-ui-icon-btn" aria-label="Rename conversation">${I.pencil}</button>
            <div class="lmsa-history-item-delete-area">
              <button class="lmsa-history-btn lmsa-history-trash-btn lmsa-ui-icon-btn" aria-label="Delete conversation">${I.trash}</button>
            </div>
          </div>
        </div>
      </div>`,
      400,
    ),
  },

  // S15: history drawer closed. The base .lmsa-history-drawer rule is display:none, so inside the probe
  // host only the content marker should show, no residual sliver, no layout shove.
  historyDrawerClosed: {
    w: 400,
    shot: ".lmsa-drawer-probe",
    html: view(
      `<div class="lmsa-drawer-probe">
        <div class="lmsa-history-drawer">
          <div class="lmsa-history-header"><div class="lmsa-history-title-group"><span class="lmsa-history-title">Chat history</span></div></div>
        </div>
        <div class="lmsa-drawer-probe-content">Chat content (drawer closed)</div>
      </div>`,
      400,
    ),
  },

  // S16: settings General tab, two section cards.
  settingsGeneral: {
    shot: ".lmsa-settings-panel",
    html: settingsView(
      section(
        "Active note",
        `<p class="lmsa-settings-section-desc">Include your currently open note as context so chat responses stay grounded in your writing.</p>
        ${settingItem("Include active note as context", "Send the content of the currently open note alongside each request.", sw("is-enabled"))}
        ${settingItem("Include local attachments as context when supported", "When a note is attached and the active model supports vision, send supported local image embeds as extra context.", sw())}
        ${settingItem("Note context limit", "Maximum characters of note text sent as context, 1000-200000 (default 8000).", `<input type="text" value="8000">`)}`,
      ) +
        section(
          "Support",
          `<p class="lmsa-settings-section-desc">This plugin and all of its features are, and will always be, free. If it helped you get closer to your creative goals, you can support the project.</p>
          <div class="lmsa-support-grid">
            <div class="lmsa-support-card">
              <div class="lmsa-support-card-icon">${I.star}</div>
              <div class="lmsa-support-card-text">
                <div class="lmsa-support-card-name">Buy Me a Coffee</div>
                <div class="lmsa-support-card-desc">One-time support</div>
              </div>
            </div>
          </div>`,
        ),
    ),
  },

  // S17: settings Providers tab, provider cards (brand-tint icons, status dots, auth fields).
  settingsProviders: {
    shot: ".lmsa-settings-panel",
    html: settingsView(
      `<div class="lmsa-provider-cards">
        <div class="lmsa-provider-card is-expanded">
          <div class="lmsa-provider-card-header">
            <div class="lmsa-provider-card-iconwrap">
              <div class="lmsa-provider-card-icon lmsa-brand-tint-anthropic">${BRAND.anthropic}</div>
              <span class="lmsa-provider-status-dot is-ok"></span>
            </div>
            <div class="lmsa-provider-card-info">
              <div class="lmsa-provider-card-name-row">
                <span class="lmsa-provider-card-name">Anthropic</span>
                <span class="lmsa-provider-card-version lmsa-hidden"></span>
              </div>
              <div class="lmsa-provider-card-status">API key set · 8 models available in chat</div>
            </div>
            <span class="lmsa-provider-card-chevron">${I.chevronDown}</span>
            <div class="lmsa-provider-card-toggle">${sw("is-enabled")}</div>
          </div>
          <div class="lmsa-provider-card-bodywrap"><div class="lmsa-provider-card-bodyclip"><div class="lmsa-provider-card-body">
            ${settingItem("API key", "Stored locally in this vault and never shared. Saving a key enables the provider.", `<input type="password" placeholder="sk-ant-…">`)}
            <div class="lmsa-provider-models">
              <div class="lmsa-provider-models-header">
                <span class="lmsa-provider-models-title">Models</span>
                <span class="lmsa-provider-models-meta">Built-in catalog</span>
              </div>
              <div class="lmsa-item-list">
                <div class="lmsa-item-row lmsa-provider-model-row">
                  <div class="lmsa-item-info">
                    <div class="lmsa-provider-model-name">Claude Sonnet 4.5</div>
                    <div class="lmsa-provider-model-id">claude-sonnet-4-5</div>
                  </div>
                  <div class="lmsa-provider-model-badges">
                    <span class="lmsa-provider-role-chip">completion</span>
                    <span class="lmsa-provider-context-chip">200K context</span>
                  </div>
                </div>
              </div>
            </div>
          </div></div></div>
        </div>
        <div class="lmsa-provider-card is-off">
          <div class="lmsa-provider-card-header">
            <div class="lmsa-provider-card-iconwrap">
              <div class="lmsa-provider-card-icon lmsa-brand-tint-lmstudio">${BRAND.lmstudio}</div>
              <span class="lmsa-provider-status-dot is-warn"></span>
            </div>
            <div class="lmsa-provider-card-info">
              <div class="lmsa-provider-card-name-row"><span class="lmsa-provider-card-name">LM Studio</span></div>
              <div class="lmsa-provider-card-status">No models discovered yet</div>
            </div>
            <span class="lmsa-provider-card-chevron">${I.chevronDown}</span>
            <div class="lmsa-provider-card-toggle">${sw()}</div>
          </div>
          <div class="lmsa-provider-card-bodywrap"><div class="lmsa-provider-card-bodyclip"><div class="lmsa-provider-card-body"></div></div></div>
        </div>
        <div class="lmsa-provider-card is-off">
          <div class="lmsa-provider-card-header">
            <div class="lmsa-provider-card-iconwrap">
              <div class="lmsa-provider-card-icon lmsa-brand-tint-claudecode">${BRAND.claudecode}</div>
              <span class="lmsa-provider-status-dot is-error"></span>
            </div>
            <div class="lmsa-provider-card-info">
              <div class="lmsa-provider-card-name-row">
                <span class="lmsa-provider-card-name">Claude Code</span>
                <span class="lmsa-provider-card-version">v2.1.201</span>
              </div>
              <div class="lmsa-provider-card-status">Not found · the Claude Code CLI is not installed or not on the system path</div>
            </div>
            <span class="lmsa-provider-card-chevron">${I.chevronDown}</span>
            <div class="lmsa-provider-card-toggle">${sw("is-disabled")}</div>
          </div>
          <div class="lmsa-provider-card-bodywrap"><div class="lmsa-provider-card-bodyclip"><div class="lmsa-provider-card-body"></div></div></div>
        </div>
      </div>
      <p class="lmsa-provider-footnote">Cloud model catalogs ship with the plugin and refresh with each release. Local models are discovered live from LM Studio.</p>`,
    ),
  },

  // S18: shared settings model selector, dropdown open (delta (a) pre-existing search border lives here).
  settingsModelSelector: {
    w: 480,
    shot: ".lmsa-settings-model-selector-wrap",
    html: settingsView(
      `<div class="lmsa-settings-model-selector-wrap">
        <div class="lmsa-settings-model-selector is-active">
          <span class="lmsa-model-selector-status is-cloud"></span>
          <span class="lmsa-settings-model-selector-label">Claude Sonnet 4.5</span>
          <span class="lmsa-settings-model-selector-chevron">${I.chevronDown}</span>
        </div>
        <div class="lmsa-model-dropdown">
          <div class="lmsa-model-dropdown-search">
            <span class="lmsa-model-dropdown-search-icon">${I.search}</span>
            <input class="lmsa-model-dropdown-search-input" type="text" placeholder="Search models...">
            <button class="lmsa-model-dropdown-refresh" aria-label="Refresh models">${I.refresh}</button>
          </div>
          <div class="lmsa-model-dropdown-body">
            <div class="lmsa-provider-rail">
              <div class="lmsa-provider-rail-item is-active" title="Favorites">${I.star}</div>
              <div class="lmsa-provider-rail-divider"></div>
              <div class="lmsa-provider-rail-item lmsa-brand-tint-anthropic" title="Anthropic">${BRAND.anthropic}</div>
              <div class="lmsa-provider-rail-item lmsa-brand-tint-lmstudio" title="LM Studio">${BRAND.lmstudio}</div>
            </div>
            <div class="lmsa-model-dropdown-list">
              <div class="lmsa-model-dropdown-item is-active">
                <span class="lmsa-model-dropdown-check">${I.check}</span>
                <div class="lmsa-model-dropdown-copy">
                  <span class="lmsa-model-dropdown-name">Claude Sonnet 4.5</span>
                  <span class="lmsa-model-dropdown-provider">Anthropic</span>
                </div>
                <span class="lmsa-model-dropdown-state is-cloud"></span>
                <span class="lmsa-model-dropdown-star is-faved">${I.star}</span>
              </div>
              <div class="lmsa-model-dropdown-item">
                <span class="lmsa-model-dropdown-check"></span>
                <div class="lmsa-model-dropdown-copy">
                  <span class="lmsa-model-dropdown-name">Llama 3.1 8B</span>
                  <span class="lmsa-model-dropdown-provider">LM Studio</span>
                </div>
                <span class="lmsa-model-dropdown-state is-unloaded"></span>
                <span class="lmsa-model-dropdown-star">${I.star}</span>
              </div>
            </div>
          </div>
        </div>
      </div>`,
      480,
    ),
  },

  // S19: settings Benchmark tab, model-selection + test-suites cards.
  settingsBenchmark: {
    shot: ".lmsa-settings-panel",
    html: settingsView(
      section(
        "Model selection",
        `<p class="lmsa-settings-section-desc">Choose a completion model to run benchmarks against. The model must be loaded.</p>
        ${settingItem(
          "Completion model",
          "The model used to run benchmark tests.",
          `<div class="lmsa-settings-model-selector-wrap lmsa-benchmark-model-wrap">
            <div class="lmsa-settings-model-selector"><span class="lmsa-model-selector-status is-unknown"></span><span class="lmsa-settings-model-selector-label">Select model...</span><span class="lmsa-settings-model-selector-chevron">${I.chevronDown}</span></div>
            <button class="lmsa-profile-settings-btn" aria-label="Profile settings">${I.gear}</button>
          </div>`,
        )}`,
      ) +
        section(
          "Test suites",
          `<div class="lmsa-benchmark-setting-row">
            <div class="lmsa-benchmark-setting-info">
              <span class="lmsa-benchmark-setting-name">Iterations per test</span>
              <span class="lmsa-benchmark-setting-desc">Run each test multiple times to measure consistency.</span>
            </div>
            <input class="lmsa-benchmark-setting-input" type="number" min="1" max="20" value="3">
          </div>
          <div class="lmsa-benchmark-setting-row">
            <div class="lmsa-benchmark-setting-info">
              <span class="lmsa-benchmark-setting-name">Report folder</span>
              <span class="lmsa-benchmark-setting-desc">Vault folder where exported reports are created.</span>
            </div>
            <input class="lmsa-benchmark-setting-input lmsa-benchmark-setting-input--wide" type="text" value="Benchmarks">
          </div>
          <div class="lmsa-benchmark-tab-bar">
            <button class="lmsa-benchmark-tab is-active"><span class="lmsa-benchmark-tab-icon">${I.pencil}</span><span>Editing</span></button>
            <button class="lmsa-benchmark-tab"><span class="lmsa-benchmark-tab-icon">${I.brain}</span><span>Reasoning</span></button>
          </div>
          <div class="lmsa-benchmark-tab-content">
            <div class="lmsa-benchmark-suite-actions">
              <button class="lmsa-benchmark-btn lmsa-benchmark-btn--run-suite"><span class="lmsa-benchmark-btn-icon">${I.arrowUp}</span><span>Run suite</span></button>
            </div>
            <div class="lmsa-benchmark-cards">
              <div class="lmsa-benchmark-card">
                <div class="lmsa-benchmark-card-header">
                  <div class="lmsa-benchmark-card-title-row">
                    <span class="lmsa-benchmark-card-name">Paragraph rewrite<span class="lmsa-benchmark-badge lmsa-benchmark-badge--control">control</span></span>
                    <span class="lmsa-benchmark-card-status is-passed">Passed</span>
                  </div>
                  <p class="lmsa-benchmark-card-desc">Rewrite a paragraph while preserving meaning.</p>
                  <div class="lmsa-benchmark-card-actions">
                    <button class="lmsa-benchmark-btn lmsa-benchmark-btn--run"><span class="lmsa-benchmark-btn-icon">${I.arrowUp}</span><span>Run</span></button>
                    <button class="lmsa-benchmark-btn lmsa-benchmark-btn--toggle"><span class="lmsa-benchmark-btn-icon">${I.chevronDown}</span><span>Details</span></button>
                  </div>
                </div>
              </div>
            </div>
            <div class="lmsa-benchmark-summary">Run tests to see results.</div>
          </div>`,
        ),
    ),
  },

  // S20: settings Index / RAG tab. The stale/drift notice (muted amber) is the key chip.
  settingsRag: {
    shot: ".lmsa-settings-panel",
    html: settingsView(
      section(
        "Vault retrieval",
        `<p class="lmsa-settings-section-desc">Automatically find and inject relevant vault content into each chat request using embedding-based search.</p>
        ${settingItem("Enable vault retrieval", "When enabled, the plugin can index your vault and retrieve relevant notes for each message.", sw("is-enabled"))}
        ${settingItem("Embedding model", "Encodes vault content as vectors for similarity search.", "")}`,
      ) +
        `<div class="lmsa-rag-conditional">${section(
          "Index",
          `<p class="lmsa-settings-section-desc">Manage the vector index used for retrieval.</p>
          <div class="lmsa-index-status">
            <div class="lmsa-index-status-header">
              <div class="lmsa-index-status-info">
                <p class="lmsa-index-status-text">128 files, 512 chunks indexed.</p>
                <p class="lmsa-index-drift-notice is-visible">Settings changed since last build. Rebuild recommended.</p>
              </div>
              <div class="lmsa-index-actions">
                <button class="lmsa-ui-btn lmsa-ui-btn-primary">Build index</button>
                <button class="lmsa-ui-btn lmsa-ui-btn-secondary is-visible">Rebuild index</button>
              </div>
            </div>
            <div class="lmsa-index-progress is-visible">
              <div class="lmsa-index-progress-bar"><div class="lmsa-index-progress-fill" style="width:42%"></div></div>
              <span class="lmsa-index-progress-text">54 / 128 files (42%)</span>
            </div>
          </div>`,
        )}</div>`,
    ),
  },

  // S21a: settings Advanced tab.
  settingsAdvanced: {
    shot: ".lmsa-settings-panel",
    html: settingsView(
      section(
        "Agentic mode",
        `<p class="lmsa-settings-section-desc">Allow the model to call tools: search your vault, read notes, and apply structured edits across multiple reasoning rounds.</p>
        ${settingItem("Enable agentic mode", "Vault search and edit tools become available.", sw())}
        ${settingItem("Max tool rounds", "Maximum read-only tool rounds per turn. Default 8.", `<input type="text" value="8">`)}`,
      ) +
        section(
          "System prompt prefix",
          `<p class="lmsa-settings-section-desc">Prepended before your custom prompt on every turn.</p>
          ${settingItem(
            "Prefix",
            "Prepended before your custom prompt on every turn.",
            `<textarea class="lmsa-monospace" rows="4" placeholder="No prefix, using your custom prompt only"></textarea>
             <button class="lmsa-ui-btn lmsa-ui-btn-secondary">Reset to default</button>`,
          )}`,
        ),
    ),
  },

  // S21d: settings Memories tab (feature card + the records table + budget bar).
  settingsMemories: {
    shot: ".lmsa-settings-panel",
    html: settingsView(
      section(
        "Memory",
        `${settingItem("Enable memories", "Deliver the memory index with every request and offer the memory tools.", sw("is-enabled"))}
        ${settingItem("Memory changes", "How the assistant's add and forget requests are handled. Deny removes both tools. The vault edit posture overrides this, as it does every other approval class.", `<select><option>Ask</option><option>Auto-apply</option><option>Deny</option></select>`)}
`,
        "",
        I.brain,
      ) +
        section(
          "Stored memories",
          memoryTable(
            `${memoryRow("no-emdashes", "rule", "Never use em dashes; use commas for asides and colons before lists.")}
             ${memoryRow("no-emojis", "rule", "Never use emojis.", false)}
             ${memoryRow("pov-limited", "rule", "Write in third person limited, one viewpoint per scene.", true, true)}
             ${memoryRow("vault-tone", "context", "The vault's grimdark tone and genre; recall when setting scene mood.")}`,
          ),
          "",
          I.file,
        ),
      720,
      "memories",
    ),
  },

  // S21e: settings Memories tab with the feature switched off (records card inactive).
  settingsMemoriesOff: {
    shot: ".lmsa-settings-panel",
    html: settingsView(
      section(
        "Memory",
        `${settingItem("Enable memories", "Deliver the memory index with every request and offer the memory tools.", sw())}
        ${settingItem("Memory changes", "How the assistant's add and forget requests are handled. Deny removes both tools. The vault edit posture overrides this, as it does every other approval class.", `<select><option>Ask</option><option>Auto-apply</option><option>Deny</option></select>`)}
`,
        "",
        I.brain,
      ) +
        section(
          "Stored memories",
          memoryOffState(),
          "",
          I.file,
        ).replace(
          '<div class="lmsa-settings-section-footer"></div>',
          '<div class="lmsa-settings-section-footer"><button class="lmsa-btn-add lmsa-ui-btn lmsa-ui-btn-primary" disabled>Add memory</button></div>',
        ),
      720,
      "memories",
    ),
  },

  // S21b: settings Knowledge-graph tab (warning card + graph status with per-folder coverage).
  settingsKnowledgeGraph: {
    shot: ".lmsa-settings-panel",
    html: settingsView(
      section(
        "Before you begin",
        `${settingItem("Compute", "Every note is sent to a completion model to extract entities and relationships.", "")}
        ${settingItem("Large vaults", "Extraction can take a while and consume tokens on cloud providers.", "")}`,
        "lmsa-kg-warning",
      ) +
        `<div class="lmsa-kg-conditional">${section(
          "Graph",
          `<p class="lmsa-settings-section-desc">Manage the extracted knowledge graph.</p>
          <div class="lmsa-index-status">
            <div class="lmsa-index-status-header">
              <div class="lmsa-index-status-info">
                <p class="lmsa-index-status-text">40 files processed. 312 entities, 580 relationships.</p>
                <p class="lmsa-index-drift-notice is-visible">3 files changed since the graph was built. Rebuild to refresh.</p>
              </div>
              <div class="lmsa-index-actions">
                <button class="lmsa-ui-btn lmsa-ui-btn-primary">Build graph</button>
                <button class="lmsa-ui-btn lmsa-ui-btn-secondary is-visible">Rebuild graph</button>
              </div>
            </div>
            <div class="lmsa-kg-folder-section">
              <div class="lmsa-kg-folder-row">
                <span class="lmsa-kg-folder-name">Characters</span>
                <div class="lmsa-kg-folder-bar"><div class="lmsa-kg-folder-bar-fill is-complete" style="width:100%"></div></div>
                <span class="lmsa-kg-folder-count">12 / 12</span>
                <div class="lmsa-kg-folder-action"></div>
              </div>
              <div class="lmsa-kg-folder-row">
                <span class="lmsa-kg-folder-name is-root">(root)</span>
                <div class="lmsa-kg-folder-bar"><div class="lmsa-kg-folder-bar-fill" style="width:40%"></div></div>
                <span class="lmsa-kg-folder-count">4 / 10</span>
                <div class="lmsa-kg-folder-action"><button class="lmsa-ui-btn lmsa-ui-btn-secondary lmsa-kg-folder-btn">Resume</button></div>
              </div>
              <div class="lmsa-kg-folder-row">
                <span class="lmsa-kg-folder-name">Locations</span>
                <div class="lmsa-kg-folder-bar"><div class="lmsa-kg-folder-bar-fill" style="width:60%"></div></div>
                <span class="lmsa-kg-folder-count">6 / 10</span>
                <div class="lmsa-kg-folder-action"><button class="lmsa-ui-btn lmsa-kg-folder-btn lmsa-kg-folder-stop-btn">Stop</button></div>
              </div>
            </div>
          </div>`,
        )}</div>`,
    ),
  },

  // Phase 4: exact prose and tool interleaving with same-segment tools, separate
  // silent segments, full markdown, a pending write review, and iconless final prose.
  assistantTurnInterleaved: {
    w: 680,
    shot: ".lmsa-chat-window-message--assistant",
    html: view(
      assistantBubble(
        assistantTurn(
          turnItem(
            "prose-1",
            "prose",
            "thinking",
            "<p>I will inspect the opening before changing it.</p>",
          ) +
            turnItem(
              "tool-1",
              "tool_call",
              "tool",
              toolTurnBody(
                "Read file",
                "Drafts/Opening.md",
                "Completed",
                `<div class="lmsa-agentic-timeline-arg-entry"><span class="lmsa-agentic-timeline-arg-key">Result</span><pre class="lmsa-agentic-timeline-arg-value">The room was quiet.</pre></div>`,
              ),
              { state: "completed" },
            ) +
            turnItem(
              "prose-2",
              "prose",
              "thinking",
              `<p>The image is clear, but the verb can carry more tension.</p>
               <ul><li>Keep the room quiet.</li><li>Sharpen the character movement.</li></ul>`,
            ) +
            turnItem(
              "tool-2",
              "tool_call",
              "tool",
              toolTurnBody("Propose edit", "Drafts/Opening.md", "Running"),
              {
                state: "running",
                mutating: true,
                segment: "segment-2",
                action: `<div class="lmsa-edit-step-controls">
                  <span class="lmsa-edit-step-pending">pending review</span>
                  <button class="lmsa-edit-step-btn lmsa-edit-step-btn--approve" aria-label="Accept">${I.check}</button>
                  <button class="lmsa-edit-step-btn lmsa-edit-step-btn--decline" aria-label="Reject">${I.x}</button>
                </div>`,
              },
            ) +
            turnItem(
              "tool-3",
              "tool_call",
              "tool",
              toolTurnBody("Update frontmatter", "Drafts/Opening.md", "Completed"),
              {
                state: "completed",
                mutating: true,
                segment: "segment-2",
              },
            ) +
            turnItem(
              "tool-4",
              "tool_call",
              "tool",
              toolTurnBody("Read file", "Style guide.md", "Completed"),
              { state: "completed", segment: "segment-3" },
            ) +
            turnItem(
              "prose-3",
              "prose",
              "iconless",
              `<p>The opening is tighter now. The revised line keeps the silence while giving the movement more urgency.</p>`,
              { after: false, fade: true, segment: "segment-4" },
            ),
        ),
      ),
      680,
    ),
  },

  // Phase 4 lifecycle gallery: live empty placeholder, tool-only completion,
  // interruption after prose, failed empty turn, and honest completed empty turn.
  assistantTurnStates: {
    w: 620,
    shot: ".lmsa-chat-window-messages",
    html: view(
      `<div class="lmsa-messages-pane"><div class="lmsa-chat-window-messages">
        ${assistantBubble(
          assistantTurn(
            "",
            "streaming",
            `<div class="lmsa-assistant-turn-empty is-streaming" aria-hidden="true">
              <span class="lmsa-assistant-turn-empty-marker">${I.more}</span>
              <span class="lmsa-assistant-turn-empty-label">Assistant is responding.</span>
            </div>`,
          ),
        )}
        ${assistantBubble(
          assistantTurn(
            turnItem(
              "tool-only",
              "tool_call",
              "tool",
              toolTurnBody("Searched vault", "character arc", "Completed"),
              { after: false, state: "completed" },
            ),
          ),
        )}
        ${assistantBubble(
          assistantTurn(
            turnItem(
              "partial-prose",
              "prose",
              "iconless",
              "<p>I found the relevant scene, but generation stopped before the summary completed.</p>",
              { after: false },
            ),
            "interrupted",
            `<div class="lmsa-assistant-turn-notice" role="status">Generation stopped.</div>`,
          ),
        )}
        ${assistantBubble(
          assistantTurn(
            "",
            "failed",
            `<div class="lmsa-assistant-turn-empty is-failed" role="status">
              <span class="lmsa-assistant-turn-empty-marker">${I.x}</span>
              <span class="lmsa-assistant-turn-empty-label">Error: Connection closed.</span>
            </div>`,
          ),
        )}
        ${assistantBubble(
          assistantTurn(
            "",
            "completed",
            `<div class="lmsa-assistant-turn-empty is-completed">
              <span class="lmsa-assistant-turn-empty-marker">${I.more}</span>
              <span class="lmsa-assistant-turn-empty-label">No response.</span>
            </div>`,
          ),
        )}
      </div></div>`,
      620,
    ),
  },

  // Phase 4 out-of-band action placement and ordered memory and ask details.
  assistantTurnActionPlacement: {
    w: 650,
    shot: ".lmsa-chat-window-message--assistant",
    html: view(
      assistantBubble(
        assistantTurn(
          turnItem(
            "memory-1",
            "tool_call",
            "tool",
            toolTurnBody("Add memory", "Narration: restrained", "Running"),
            {
              state: "running",
              mutating: true,
              action: `<div class="lmsa-memory-step-controls lmsa-vault-step-controls">
                <span class="lmsa-vault-step-pending">pending approval</span>
                <button class="lmsa-vault-step-btn lmsa-vault-step-btn--approve" aria-label="Approve">${I.check}</button>
                <button class="lmsa-vault-step-btn lmsa-vault-step-btn--decline" aria-label="Decline">${I.x}</button>
              </div>
              <div class="lmsa-vault-timeline-preview lmsa-memory-review-preview"><pre class="lmsa-agentic-timeline-arg-value">Prefer restrained narration with concrete images.</pre></div>`,
            },
          ) +
            turnItem(
              "ask-1",
              "tool_call",
              "tool",
              toolTurnBody(
                "Asked a question",
                "Output format",
                "Completed",
                `<div class="lmsa-agentic-timeline-arg-entry">
                  <span class="lmsa-agentic-timeline-arg-key">Output</span>
                  <pre class="lmsa-agentic-timeline-arg-value">Which format should I use?\nDetailed</pre>
                </div>`,
              ),
              { after: false, state: "completed", segment: "segment-2" },
            ),
          "completed",
          `<section class="lmsa-assistant-turn-provisional lmsa-assistant-turn-action-section" aria-label="Pending review that has not received an ordered provider declaration">
            <div class="lmsa-assistant-turn-action-section-heading">Review awaiting declaration</div>
            <div class="lmsa-assistant-turn-action-summary">
              <div class="lmsa-assistant-turn-action-heading"><span class="lmsa-assistant-turn-action-family">Vault operation</span><span class="lmsa-assistant-turn-action-state">pending review</span></div>
              <div class="lmsa-assistant-turn-action-placement">Waiting for the provider declaration.</div>
            </div>
          </section>
          <section class="lmsa-assistant-turn-audit lmsa-assistant-turn-action-section" aria-label="Action history without a correlated provider declaration">
            <div class="lmsa-assistant-turn-action-section-heading">Unplaced action audit</div>
            <div class="lmsa-assistant-turn-action-summary">
              <div class="lmsa-assistant-turn-action-heading"><span class="lmsa-assistant-turn-action-family">Edit review</span><span class="lmsa-assistant-turn-action-state">declined</span></div>
              <div class="lmsa-assistant-turn-action-placement is-warning">The action has effect history, but no provider declaration could be placed.</div>
            </div>
          </section>`,
        ),
      ),
      650,
    ),
  },

  // Phase 4 narrow-pane pressure test with long markdown, code, and consecutive tools.
  assistantTurnNarrow: {
    w: 330,
    shot: ".lmsa-chat-window-message--assistant",
    html: view(
      assistantBubble(
        assistantTurn(
          turnItem(
            "narrow-prose-1",
            "prose",
            "thinking",
            `<p>This deliberately long paragraph verifies that prose wraps inside a narrow sidebar without moving the text edge or forcing the rail outside the pane.</p>
             <div class="lmsa-md-codeblock"><div class="lmsa-md-codeblock-header"><span class="lmsa-md-codeblock-language">typescript</span><button class="lmsa-md-codeblock-copy">Copy</button></div><pre class="lmsa-md-codeblock-pre"><code>const sentence = "A long line remains horizontally scrollable inside its own code block.";</code></pre></div>`,
          ) +
            turnItem(
              "narrow-tool-1",
              "tool_call",
              "tool",
              toolTurnBody("Read file", "Drafts/A very long note name.md", "Completed"),
              { state: "completed" },
            ) +
            turnItem(
              "narrow-tool-2",
              "tool_call",
              "tool",
              toolTurnBody("Searched vault", "motif continuity", "Completed"),
              { after: false, state: "completed" },
            ),
        ),
      ),
      330,
    ),
  },

  // S22: edit review attached to the exact ordered assistant item.
  diffTimeline: {
    w: 620,
    shot: ".lmsa-chat-window-message--assistant",
    html: view(
      assistantBubble(
        assistantTurn(
          turnItem(
            "edit-prose",
            "prose",
            "thinking",
            "<p>I will tighten the opening line.</p>",
          ) +
            turnItem(
              "edit-tool",
              "tool_call",
              "tool",
              toolTurnBody("Propose edit", "Chapter 1.md", "Running"),
              {
                after: false,
                state: "running",
                mutating: true,
                action: `<div class="lmsa-edit-step-controls">
                  <span class="lmsa-edit-step-pending">pending review</span>
                  <button class="lmsa-edit-step-btn lmsa-edit-step-btn--approve" aria-label="Accept">${I.check}</button>
                  <button class="lmsa-edit-step-btn lmsa-edit-step-btn--decline" aria-label="Reject">${I.x}</button>
                </div>
                <div class="lmsa-edit-timeline-hunk">${splitHunk("pending")}</div>`,
              },
            ),
        ),
      ),
      620,
    ),
  },

  // S23: vault-review timeline (write op preview + step controls + turn footer). Plus a standalone
  // dismissable chip to exercise the lmsa-ui-chip-dismiss !important override (cascade check-item; no
  // component emits it inside the timeline, per source).
  vaultReviewTimeline: {
    w: 620,
    shot: ".lmsa-chat-window-message--assistant",
    html: view(
      assistantBubble(
        assistantTurn(
          turnItem(
            "vault-tool",
            "tool_call",
            "tool",
            toolTurnBody("Write file", "Notes/New Scene.md", "Running"),
            {
              after: false,
              state: "running",
              mutating: true,
              action: `<div class="lmsa-vault-step-controls">
                <span class="lmsa-vault-step-pending">pending approval</span>
                <button class="lmsa-vault-step-btn lmsa-vault-step-btn--approve" aria-label="Approve">${I.check}</button>
                <button class="lmsa-vault-step-btn lmsa-vault-step-btn--decline" aria-label="Decline">${I.x}</button>
              </div>
              <div class="lmsa-vault-timeline-preview">
                <div class="lmsa-chat-window-diff-hunk" data-status="pending">
                  <div class="lmsa-chat-window-diff-hunk-body lmsa-chat-window-diff-hunk-body--split">
                    <div class="lmsa-chat-window-diff-row">
                      <div class="lmsa-chat-window-diff-side lmsa-chat-window-diff-side--left lmsa-chat-window-diff-side--empty"></div>
                      <div class="lmsa-chat-window-diff-side lmsa-chat-window-diff-side--right lmsa-chat-window-diff-line--added">
                        <span class="lmsa-chat-window-diff-gutter"></span>
                        <span class="lmsa-chat-window-diff-text"># New Scene</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>`,
            },
          ),
          "streaming",
          `<div class="lmsa-vault-review-footer">
            <button class="lmsa-vault-review-footer-btn lmsa-vault-review-footer-btn--approve"><span class="lmsa-vault-review-footer-btn-icon">${I.check}</span>Approve all remaining</button>
            <button class="lmsa-vault-review-footer-btn"><span class="lmsa-vault-review-footer-btn-icon">${I.refresh}</span>Undo</button>
          </div>`,
        ),
      ),
      620,
    ),
  },

  // S24: edit-review timeline, multi-hunk populated state (one applied + undo, one pending) + bulk bar.
  editReviewTimeline: {
    w: 620,
    shot: ".lmsa-chat-window-message--assistant",
    html: view(
      assistantBubble(
        assistantTurn(
          turnItem(
            "edit-applied",
            "tool_call",
            "tool",
            toolTurnBody("Proposed edit", "Chapter 1.md", "Completed"),
            {
              state: "completed",
              mutating: true,
              action: `<div class="lmsa-edit-step-controls">
                <span class="lmsa-edit-step-state">Applied</span>
                <button class="lmsa-edit-step-btn lmsa-edit-step-btn--undo" aria-label="Undo">${I.refresh}</button>
              </div>
              <div class="lmsa-edit-timeline-hunk">${splitHunk("applied")}</div>`,
            },
          ) +
            turnItem(
              "edit-pending",
              "tool_call",
              "tool",
              toolTurnBody("Propose edit", "Chapter 2.md", "Running"),
              {
                after: false,
                state: "running",
                mutating: true,
                action: `<div class="lmsa-edit-step-controls">
                  <span class="lmsa-edit-step-pending">pending review</span>
                  <button class="lmsa-edit-step-btn lmsa-edit-step-btn--approve" aria-label="Accept">${I.check}</button>
                  <button class="lmsa-edit-step-btn lmsa-edit-step-btn--decline" aria-label="Reject">${I.x}</button>
                </div>
                <div class="lmsa-edit-timeline-hunk">${splitHunk("pending")}</div>`,
              },
            ),
          "streaming",
          `<div class="lmsa-edit-review-bulk">
            <button class="lmsa-ui-compact-btn lmsa-edit-bulk-btn lmsa-edit-bulk-btn--accept">Accept all (2)</button>
            <button class="lmsa-ui-compact-btn lmsa-ui-compact-btn-secondary lmsa-edit-bulk-btn">Reject all</button>
            <button class="lmsa-ui-compact-btn lmsa-ui-compact-btn-secondary lmsa-edit-bulk-btn">Accept all this session</button>
          </div>`,
        ),
      ),
      620,
    ),
  },

  // S25: inline diff decoration in the editor (CM6 mark + block widget). Add/remove coloring, no gutter
  // class of our own (Obsidian's native gutters show through unstyled, the correct expectation).
  inlineDiff: {
    w: 560,
    shot: ".cm-editor",
    html: view(
      `<div class="cm-editor"><div class="cm-scroller"><div class="cm-content">
        <div class="cm-line">The morning was quiet.</div>
        <div class="cm-line"><span class="lmsa-inline-diff-removed">She walked home.</span></div>
        <div class="lmsa-inline-diff-block">
          <div class="lmsa-inline-diff-added">She hurried home.</div>
          <div class="lmsa-inline-diff-actions">
            <button class="lmsa-inline-diff-btn lmsa-inline-diff-btn--accept" type="button">Accept</button>
            <button class="lmsa-inline-diff-btn lmsa-inline-diff-btn--reject" type="button">Reject</button>
          </div>
        </div>
        <div class="cm-line">The rain began to fall.</div>
      </div></div></div>`,
      560,
    ),
  },

  // S26: settings navigation rail (SettingsTab.ts renderRail). The rail is the sibling of the stage
  // inside .lmsa-settings-shell and is absent from settingsView(), so the rail-item button-reset overrides
  // (SettingsTab.css base block + is-active block) had no harness coverage. One item is-active so the
  // is-active background/box-shadow overrides render; the group is-active so the label accent renders.
  // Hover (rail-item:hover, group-label hover) stays live-app: the harness is static.
  settingsRail: {
    w: 200,
    shot: ".lmsa-settings-rail",
    html: `<div class="lmsa-harness-stage" style="width:180px">
      <div class="lmsa-settings-root"><div class="lmsa-settings-shell">
        <div class="lmsa-settings-rail">
          <div class="lmsa-settings-rail-group is-active">
            <span class="lmsa-settings-rail-group-label">Chat</span>
            <button class="lmsa-settings-rail-item is-active" type="button">
              <span class="lmsa-settings-rail-icon">${I.gear}</span>
              <span class="lmsa-settings-rail-label">General</span>
            </button>
            <button class="lmsa-settings-rail-item" type="button">
              <span class="lmsa-settings-rail-icon">${I.database}</span>
              <span class="lmsa-settings-rail-label">Providers</span>
            </button>
          </div>
          <div class="lmsa-settings-rail-group">
            <span class="lmsa-settings-rail-group-label">Retrieval</span>
            <button class="lmsa-settings-rail-item" type="button">
              <span class="lmsa-settings-rail-icon">${I.brain}</span>
              <span class="lmsa-settings-rail-label">Knowledge</span>
            </button>
          </div>
        </div>
      </div></div>
    </div>`,
  },

  // S27: chat header row (createChatLayout.ts): model-selector trigger + the two header icon buttons.
  // The composer/transcript surfaces omit the header, so .lmsa-chat-header-actions .lmsa-ui-icon-btn
  // (view-scoped background override) and .lmsa-profile-settings-btn in the chat context had no coverage.
  // Hover stays live-app.
  chatHeader: {
    w: 520,
    shot: ".lmsa-chat-header",
    html: view(
      `<div class="lmsa-chat-header">
        <div class="lmsa-chat-header-copy">
          <div class="lmsa-chat-header-title">Writing assistant chat</div>
          <div class="lmsa-chat-header-meta-wrap">
            <div class="lmsa-chat-header-meta is-active">
              <span class="lmsa-chat-header-meta-label">Claude Sonnet 4.5</span>
              <span class="lmsa-model-selector-status is-cloud"></span>
              <span class="lmsa-chat-header-meta-chevron">${I.chevronDown}</span>
            </div>
            <button class="lmsa-profile-settings-btn" aria-label="Profile settings">${I.gear}</button>
          </div>
        </div>
        <div class="lmsa-chat-header-actions">
          <button class="lmsa-chat-header-btn lmsa-ui-icon-btn" aria-label="New chat">${I.file}</button>
          <button class="lmsa-chat-header-btn lmsa-ui-icon-btn" aria-label="Chat history">${I.gear}</button>
        </div>
      </div>`,
      520,
    ),
  },

  // S28: floating overlay affordances rendered in flow. The jump-to-latest pill (.lmsa-scroll-to-bottom,
  // a button per ChatTranscript.ts) and the generate-response button (.lmsa-chat-composer-generate-btn, a button normally carrying
  // lmsa-hidden) are absolutely positioned and absent from the at-rest composer/transcript surfaces, so
  // their transparent-background / no-shadow overrides had no coverage. Rendered here (generate button
  // without lmsa-hidden); their anchored top/left offsets and translate are position-dependent, neutralized
  // inline like SCAFFOLD does for popovers, so the anchored placement is a live-app check, the chrome is not.
  floatingButtons: {
    w: 360,
    shot: ".lmsa-floating-probe",
    html: view(
      `<div class="lmsa-floating-probe" style="position:relative;width:320px;height:120px;display:flex;align-items:center;justify-content:center;gap:14px">
        <button class="lmsa-scroll-to-bottom" style="position:static;transform:none">
          <span>Jump to latest</span>${I.chevronDown}
        </button>
        <button class="lmsa-chat-composer-generate-btn" style="position:static;transform:none" aria-label="Generate response">
          <span class="lmsa-chat-composer-generate-icon">${I.arrowUp}</span>Generate response
        </button>
      </div>`,
      360,
    ),
  },
};

import { settingsPanelHeader, settingsRail } from "./fixtures/settings.mjs";

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
export const view = (inner, w, { posture = "ask", rootClass = "" } = {}) =>
  `<div class="lmsa-harness-stage"${w ? ` style="width:${w}px"` : ""}>
     <div class="workspace-leaf-content" data-type="writing-assistant-chat">
       <div class="view-content lmsa-root${rootClass ? ` ${rootClass}` : ""}" data-posture="${posture}">
         <div class="lmsa-shell">${inner}</div>
     </div>
     </div></div>`;

// Popovers are sensitive to their live ancestors: the overflow menu uses the composer's named
// container and the header popovers inherit sizing from the metadata wrap. These hosts preserve
// those relationships while SCAFFOLD keeps the captured component itself in flow.
export const composerFooterView = (inner, w, options) =>
  view(
    `<div class="lmsa-chat-composer">
      <div class="lmsa-chat-composer-panel">
        <div class="lmsa-chat-composer-footer">
          <div class="lmsa-chat-composer-footer-row"></div>
          ${inner}
        </div>
      </div>
    </div>`,
    w,
    options,
  );

export const composerPanelView = (inner, w, options) =>
  view(
    `<div class="lmsa-chat-composer">
      <div class="lmsa-chat-composer-panel">${inner}</div>
    </div>`,
    w,
    options,
  );

export const headerPopoverView = (inner, w, options) =>
  view(
    `<div class="lmsa-chat-header">
      <div class="lmsa-chat-header-copy">
        <div class="lmsa-chat-header-meta-wrap">${inner}</div>
      </div>
    </div>`,
    w,
    options,
  );

// Settings tabs render into the plugin's own settings chain inside Obsidian's modal, NOT the chat root.
// Reconstruct the complete rail + stage + panel, including the Obsidian Setting heading markup, so
// the panel receives the same available width and app.css cascade as it does in the live modal.
export const settingsView = (inner, w = 720, tab = "general") =>
  `<div class="lmsa-harness-stage" style="width:${w}px">
     <div class="vertical-tab-content lmsa-settings-root">
       <div class="lmsa-settings-shell" data-tab="${tab}">
         ${settingsRail(tab)}
         <div class="lmsa-settings-stage">
           <div class="lmsa-settings-panel lmsa-ui-panel">
             ${settingsPanelHeader(tab)}
             <div class="lmsa-settings-content">${inner}</div>
           </div>
         </div>
       </div>
     </div>
   </div>`;

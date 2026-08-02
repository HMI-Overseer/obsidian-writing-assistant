import { settingsPageTitlebar } from "./fixtures/settings.mjs";

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
  /* Drawer stages: the interaction body is anchored above an absolutely-placed composer,
     so both interaction kinds need the same bounded stage to render in. */
  .lmsa-ask-visual-stage,.lmsa-approval-visual-stage{position:relative;height:760px;overflow:hidden}
  .lmsa-ask-visual-stage>.lmsa-chat-composer,
  .lmsa-approval-visual-stage>.lmsa-chat-composer{position:absolute;right:0;bottom:0;left:0}
  /* Composite drawer + timeline stages. The fixed-height stage above models the drawer
     floating over a scrolled transcript, which is true but crops the assistant turn behind
     the drawer, so it cannot answer "what does the timeline still show". This variant drops
     the stage to its content and lets the composer sit in flow, the same anchored-position
     neutralization this scaffold does for popovers, so the whole turn and the whole drawer
     are both in frame. */
  .lmsa-approval-visual-stage.is-flow{height:auto;overflow:visible}
  .lmsa-approval-visual-stage.is-flow>.lmsa-chat-composer{position:relative}
  /* The drawer is absolutely anchored above the composer (bottom:calc(100% - 12px)), so
     un-anchoring the composer alone throws it off the top of the stage. Put the drawer in
     flow too, keeping its 24px side inset and its 12px tuck into the composer, so the
     stack reads transcript, drawer, composer with nothing overlapping and nothing cropped. */
  .lmsa-approval-visual-stage.is-flow .lmsa-chat-composer-interaction-body{
    position:static;margin:0 24px -12px;max-height:none}
  /* No stand-in bubble styling here on purpose. The drawer stages render the plugin's real
     transcript markup (the userMessage / assistantProse / messagesPane helpers in
     fixtures/chat.mjs), so message chrome comes from styles.css like every other surface.
     Invented chrome in the scaffold made half the family unreviewable: a reader could not
     tell whether what they were looking at was the plugin or the harness. */
  .lmsa-ask-visual-stage>.lmsa-messages-pane,
  .lmsa-approval-visual-stage>.lmsa-messages-pane{padding:24px 20px}
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

// Settings tabs render into a SettingPage inside Obsidian's settings modal, NOT the chat root.
// Reconstruct the page chrome Obsidian builds around it (read from the installed app: rootEl is
// `.setting-page.vertical-tab-content`, holding a `.setting-page-titlebar` and a
// `.setting-page-content`), so the panel receives the same available width and app.css cascade as
// it does in the live modal. `.lmsa-settings-root` and `data-tab` sit on the page root because
// that is where ImperativeTabPage puts them, and the design tokens hang off both.
export const settingsView = (inner, w = 720, tab = "general") =>
  `<div class="lmsa-harness-stage" style="width:${w}px">
     <div class="setting-page vertical-tab-content lmsa-settings-root" data-tab="${tab}">
       ${settingsPageTitlebar(tab)}
       <div class="setting-page-content">
         <div class="lmsa-settings-panel lmsa-ui-panel">
           <div class="lmsa-settings-content">${inner}</div>
         </div>
       </div>
     </div>
   </div>`;

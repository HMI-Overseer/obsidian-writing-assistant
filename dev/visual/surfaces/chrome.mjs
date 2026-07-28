import { view } from "../scaffold.mjs";
import { I } from "../fixtures/icons.mjs";

export const CHROME_SURFACES = {

  // S14: history drawer open (active + normal rows, search, header). Row actions are opacity:0 until
  // hover; that is the correct at-rest look.
  historyDrawer: {
    source: "src/chat/view/ChatHistoryDrawer.ts",
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
    source: "src/chat/view/ChatHistoryDrawer.ts",
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

  // S27: chat header row (createChatLayout.ts): model-selector trigger + the two header icon buttons.
  // The composer/transcript surfaces omit the header, so .lmsa-chat-header-actions .lmsa-ui-icon-btn
  // (view-scoped background override) and .lmsa-profile-settings-btn in the chat context had no coverage.
  // Hover stays live-app.
  chatHeader: {
    source: "src/chat/view/createChatLayout.ts",
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
          <button class="lmsa-chat-header-btn lmsa-ui-icon-btn" aria-label="New chat">${I.filePen}</button>
          <button class="lmsa-chat-header-btn lmsa-ui-icon-btn" aria-label="Chat history">${I.clock}</button>
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
    source: "src/chat/view/createChatLayout.ts",
    w: 360,
    shot: ".lmsa-floating-probe",
    html: view(
      `<div class="lmsa-floating-probe" style="position:relative;width:320px;height:120px;display:flex;align-items:center;justify-content:center;gap:14px">
        <button class="lmsa-scroll-to-bottom" style="position:static;transform:none">
          <span>Jump to latest</span>${I.chevronDown}
        </button>
        <button class="lmsa-chat-composer-generate-btn" style="position:static;transform:none" aria-label="Generate response">
          <span class="lmsa-chat-composer-generate-icon">${I.sparkles}</span>Generate response
        </button>
      </div>`,
      360,
    ),
  },
};

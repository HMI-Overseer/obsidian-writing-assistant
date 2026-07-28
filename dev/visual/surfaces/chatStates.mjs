import { view } from "../scaffold.mjs";
import { composerFooter } from "../fixtures/chat.mjs";
import { BRAND, I } from "../fixtures/icons.mjs";
import { SCENE_IMAGE_URI } from "../fixtures/images.mjs";

export const CHAT_STATE_SURFACES = {
  // A staged image sits between context chips and the textarea. The product calls this an attachment
  // preview, while the coverage plan names the state "attached-image chip".
  attachedImageChip: {
    source: "src/chat/composer/ChatComposer.ts",
    w: 600,
    shot: ".lmsa-chat-composer-panel",
    html: view(
      `<div class="lmsa-chat-composer">
        <div class="lmsa-chat-composer-panel">
          <div class="lmsa-chat-composer-normal-body" aria-hidden="false">
            <div class="lmsa-chat-composer-chips">
              <button class="lmsa-chat-composer-add-context-btn" aria-label="Add context">${I.plus}</button>
            </div>
            <div class="lmsa-chat-composer-attachments">
              <div class="lmsa-chat-composer-attachment">
                <img class="lmsa-chat-composer-attachment-img" src="${SCENE_IMAGE_URI}" alt="harbor-dusk.png">
                <button class="lmsa-chat-composer-attachment-remove" aria-label="Remove attachment">${I.x}</button>
              </div>
            </div>
            <textarea class="lmsa-chat-composer-textarea" rows="1" placeholder="Ask anything about your writing...">Describe the mood of this setting.</textarea>
          </div>
          <div class="lmsa-chat-composer-interaction-body" aria-hidden="true" hidden></div>
          ${composerFooter()}
        </div>
      </div>`,
      600,
    ),
  },

  // ModelDropdownView crosses to a compact, list-only structure when discovery returns no models.
  modelDropdownEmptyCatalog: {
    source: "src/chat/models/ModelDropdownView.ts",
    w: 460,
    shot: ".lmsa-model-dropdown",
    html: view(
      `<div class="lmsa-model-dropdown">
        <div class="lmsa-model-dropdown-list">
          <div class="lmsa-model-dropdown-empty">No models available. Enable a provider in settings.</div>
        </div>
      </div>`,
      460,
    ),
  },

  // A populated catalog keeps the search and provider rail mounted when the query filters every row.
  modelDropdownNoSearchMatches: {
    source: "src/chat/models/ModelDropdownView.ts",
    w: 460,
    shot: ".lmsa-model-dropdown",
    html: view(
      `<div class="lmsa-model-dropdown">
        <div class="lmsa-model-dropdown-search">
          <span class="lmsa-model-dropdown-search-icon">${I.search}</span>
          <input class="lmsa-model-dropdown-search-input" type="text" placeholder="Search models..." value="no-such-model">
          <button class="lmsa-model-dropdown-refresh" aria-label="Refresh models">${I.refresh}</button>
        </div>
        <div class="lmsa-model-dropdown-body">
          <div class="lmsa-provider-rail">
            <div class="lmsa-provider-rail-item" title="Favorites">${I.star}</div>
            <div class="lmsa-provider-rail-divider"></div>
            <div class="lmsa-provider-rail-item lmsa-brand-tint-lmstudio is-active" title="LM Studio">${BRAND.lmstudio}</div>
            <div class="lmsa-provider-rail-item lmsa-brand-tint-anthropic" title="Anthropic">${BRAND.anthropic}</div>
            <div class="lmsa-provider-rail-item lmsa-brand-tint-openai" title="OpenAI">${BRAND.openai}</div>
            <div class="lmsa-provider-rail-item lmsa-brand-tint-claudecode" title="Claude Code">${BRAND.claudecode}</div>
          </div>
          <div class="lmsa-model-dropdown-list">
            <div class="lmsa-model-dropdown-empty">No models match your search</div>
          </div>
        </div>
      </div>`,
      460,
    ),
  },

  // Narrow-pane pressure case with the exact createChatLayout header hierarchy and a deliberately
  // long active model label. No hover, focus, or active-state override is forced.
  chatHeaderPressure: {
    source: "src/chat/view/createChatLayout.ts",
    w: 330,
    shot: ".lmsa-chat-header",
    html: view(
      `<div class="lmsa-chat-header">
        <div class="lmsa-chat-header-copy">
          <div class="lmsa-chat-header-title">Writing assistant chat</div>
          <div class="lmsa-chat-header-meta-wrap">
            <div class="lmsa-chat-header-meta">
              <span class="lmsa-chat-header-meta-label">Claude Opus 4.8 Extended Thinking, Long Context Profile</span>
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
      330,
    ),
  },
};

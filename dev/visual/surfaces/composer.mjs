import { view } from "../scaffold.mjs";
import { composerHtml, menuItem } from "../fixtures/chat.mjs";
import { BRAND, I } from "../fixtures/icons.mjs";
import { toggle } from "../fixtures/primitives.mjs";

export const COMPOSER_SURFACES = {
  // Composer at rest, wide enough that every footer control shows in place.
  composer: {
    source: "src/chat/composer/ChatComposer.ts",
    w: 600,
    shot: ".lmsa-chat-composer",
    html: view(composerHtml(), 600),
  },

  // S4: composer while a vault note is dragged over it. Exercises the drag-outline trick that depends
  // on the reserved invisible border (compensation #3). The dashed ring must appear with no 1px shift.
  composerDragOver: {
    source: "src/chat/composer/ChatComposer.ts",
    w: 600,
    shot: ".lmsa-chat-composer",
    html: view(composerHtml(true), 600),
  },

  // S10: footer framed on its own so the context-capacity ring geometry/color is easy to A/B.
  footerRing: {
    source: "src/chat/view/createChatLayout.ts",
    w: 600,
    shot: ".lmsa-chat-composer-footer",
    html: view(composerHtml(), 600),
  },

  // Chat model dropdown: search + provider rail (four brand tints) + item list with status dots.
  modelDropdown: {
    source: "src/chat/models/ModelDropdownView.ts",
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
    source: "src/chat/composer/KnowledgePopover.ts",
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

  // S5: reasoning pill menu open. Reasoning rows have no icon; the selected row carries a trailing check.
  reasoningMenu: {
    source: "src/chat/composer/ReasoningPill.ts",
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
    source: "src/chat/composer/PosturePill.ts",
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
    source: "src/chat/composer/ContextPickerPopover.ts",
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
    source: "src/chat/composer/ToolUsePopover.ts",
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
    source: "src/chat/composer/ComposerOverflowMenu.ts",
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
    source: "src/chat/models/ProfileSettingsPopover.ts",
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
};

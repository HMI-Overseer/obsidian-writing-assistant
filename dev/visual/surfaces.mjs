// DOM registry for the visual harness. Each surface reconstructs a component's DOM from its render
// source (the class names the `.ts` emits) so it can be rendered standalone. Faithful, but a model of
// the live DOM, not the live app: add a surface by reading its render `.ts` and mirroring the structure.

// Icon stand-ins for Obsidian's setIcon (lucide) glyphs. Geometry only; colored via currentColor.
const ic = (paths, n = 16) =>
  `<svg viewBox="0 0 24 24" width="${n}" height="${n}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
export const I = {
  chevronDown: ic('<path d="M6 9l6 6 6-6"/>'),
  chevronUp: ic('<path d="M18 15l-6-6-6 6"/>'),
  brain: ic('<path d="M9 3a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 0V4a3 3 0 0 0-3-1z"/>'),
  wrench: ic('<path d="M14 7a4 4 0 0 1-5 5L5 16l3 3 4-4a4 4 0 0 0 5-5z"/>'),
  database: ic('<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/>'),
  eye: ic('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  plus: ic('<path d="M12 5v14M5 12h14"/>'),
  arrowUp: ic('<path d="M12 19V5M5 12l7-7 7 7"/>'),
  more: ic('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
  x: ic('<path d="M6 6l12 12M18 6L6 18"/>', 12),
  file: ic('<path d="M5 3h9l5 5v13H5z"/>', 12),
  search: ic('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/>', 14),
  refresh: ic('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>', 14),
  check: ic('<path d="M20 6L9 17l-5-5"/>', 14),
  star: ic('<path d="M12 3l2.9 6 6.1.9-4.5 4.3 1.1 6.1L12 17.8 6.4 20.3l1.1-6.1L3 9.9 9.1 9z"/>', 14),
  gear: ic('<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>', 12),
};

// Harness-only scaffolding. Never mirrors plugin CSS; it only neutralizes anchored/absolute positioning
// so an element screenshot captures the component in flow, and gives popovers a realistic backdrop.
export const SCAFFOLD = `
  html,body{margin:0;padding:0}
  .lmsa-harness-stage{padding:28px;display:inline-block;background:var(--background-primary)}
  .lmsa-knowledge-popover,.lmsa-tool-popover,.lmsa-reasoning-menu,.lmsa-posture-menu,
  .lmsa-overflow-menu,.lmsa-model-dropdown,.lmsa-profile-popover,.lmsa-context-picker-popover{
    position:static!important;inset:auto!important;transform:none!important}
  .lmsa-toggle{width:34px;height:18px;border-radius:9px;background:var(--lmsa-section-accent,#58a6ff);position:relative}
  .lmsa-toggle-thumb{position:absolute;top:2px;right:2px;width:14px;height:14px;border-radius:50%;background:#fff}
`;

// Wrap component markup in the Obsidian view chain the plugin renders into
// (.workspace-leaf-content[data-type] > .view-content.lmsa-root > .lmsa-shell).
export const view = (inner, w) =>
  `<div class="lmsa-harness-stage"${w ? ` style="width:${w}px"` : ""}>
     <div class="workspace-leaf-content" data-type="writing-assistant-chat">
       <div class="view-content lmsa-root"><div class="lmsa-shell">${inner}</div></div>
     </div></div>`;

const toggle = `<div class="lmsa-knowledge-popover-control"><div class="lmsa-toggle is-enabled"><div class="lmsa-toggle-thumb"></div></div></div>`;

export const SURFACES = {
  // Composer at rest, wide enough that every footer control shows in place.
  composer: {
    w: 600,
    shot: ".lmsa-chat-composer",
    html: view(
      `<div class="lmsa-chat-composer"><div class="lmsa-chat-composer-panel">
        <div class="lmsa-chat-composer-chips">
          <button class="lmsa-chat-composer-add-context-btn" aria-label="Add context">${I.plus}</button>
          <div class="lmsa-chat-composer-chip">
            <span class="lmsa-chat-composer-chip-icon">${I.file}</span>
            <span class="lmsa-chat-composer-chip-label">Draft.md</span>
            <button class="lmsa-chat-composer-chip-remove"><span>${I.x}</span></button>
          </div>
        </div>
        <textarea class="lmsa-chat-composer-textarea" rows="1" placeholder="Ask anything about your writing..."></textarea>
        <div class="lmsa-chat-composer-footer"><div class="lmsa-chat-composer-footer-row">
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
              <span class="lmsa-chat-composer-posture-pill-icon">${I.wrench}</span>
              <span class="lmsa-chat-composer-posture-pill-label">Ask</span>
              <span class="lmsa-chat-composer-posture-pill-chevron">${I.chevronUp}</span>
            </button>
            <button class="lmsa-chat-composer-send-btn">${I.arrowUp}</button>
          </div>
        </div></div>
      </div></div>`,
      600,
    ),
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
            <div class="lmsa-provider-rail-item lmsa-brand-tint-anthropic is-active">${I.brain}</div>
            <div class="lmsa-provider-rail-item lmsa-brand-tint-openai">${I.eye}</div>
            <div class="lmsa-provider-rail-item lmsa-brand-tint-lmstudio">${I.database}</div>
            <div class="lmsa-provider-rail-item lmsa-brand-tint-claudecode">${I.wrench}</div>
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
              <div class="lmsa-settings-model-selector">
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
        </div>
      </div>`,
      360,
    ),
  },
};

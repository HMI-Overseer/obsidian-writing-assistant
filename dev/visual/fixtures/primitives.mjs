export const toggle = `<div class="lmsa-knowledge-popover-control"><div class="lmsa-toggle is-enabled"></div></div>`;

// A plain lmsa-toggle (state driven by is-enabled / is-disabled), rendered entirely by the real plugin
// CSS (thumb is a ::after, no child element). Used by the settings surfaces.
export const sw = (state = "") => `<div class="lmsa-toggle${state ? " " + state : ""}"></div>`;

// A settings section card shell (ui.ts createSection). `title` heads it; `body` is the inner markup.
// A settings section card shell, mirroring createSettingsSection(container, title, description,
// { icon }) in ui.ts: an icon badge, the title, then the description as the first child of the body.
// `icon` is required and never defaulted. Every settings tab passes its own glyph, so a fallback
// would quietly draw one generic cog across every section and misreport the whole tab at once.
export const section = (title, desc, body, icon, extraCls = "") => {
  if (!icon) {
    throw new Error(`section("${title}") needs the icon its tab passes to createSettingsSection`);
  }
  return `<div class="lmsa-settings-section lmsa-ui-card${extraCls ? " " + extraCls : ""}">
    <div class="lmsa-settings-section-header">
      <div class="lmsa-settings-section-heading">
        <div class="lmsa-settings-section-icon">${icon}</div>
        <h3 class="lmsa-settings-section-title">${title}</h3>
      </div>
      <div class="lmsa-settings-section-actions"></div>
    </div>
    <div class="lmsa-settings-section-body">${
      desc ? `<p class="lmsa-settings-section-desc">${desc}</p>` : ""
    }${body}</div>
    <div class="lmsa-settings-section-footer"></div>
  </div>`;
};

// A custom (non-Obsidian) settings row: name + description on the left, a control on the right.
// `below` is the SettingItem case where a caller mounts into `settingEl` instead of `controlEl`
// (RagTab's embedding-model selector does this), so the control lands after the control slot and
// renders full width under the row rather than beside it.
export const settingItem = (name, desc, control, below = "") =>
  `<div class="lmsa-setting-item">
    <div class="lmsa-setting-item-info">
      <div class="lmsa-setting-item-name">${name}</div>
      <div class="lmsa-setting-item-desc">${desc}</div>
    </div>
    <div class="lmsa-setting-item-control">${control}</div>${below}
  </div>`;

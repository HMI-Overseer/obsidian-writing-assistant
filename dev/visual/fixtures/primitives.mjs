export const toggle =
  `<div class="lmsa-knowledge-popover-control">` +
  `<div class="lmsa-toggle is-enabled" role="switch" aria-checked="true" tabindex="0"></div>` +
  `</div>`;

export const toggleOff =
  `<div class="lmsa-knowledge-popover-control">` +
  `<div class="lmsa-toggle" role="switch" aria-checked="false" tabindex="0"></div>` +
  `</div>`;

// A plain lmsa-toggle (state driven by is-enabled / is-disabled), rendered entirely by the real plugin
// CSS (thumb is a ::after, no child element). Used by the settings surfaces.
export const sw = (state = "") => {
  const enabled = state.split(" ").includes("is-enabled");
  const disabled = state.split(" ").includes("is-disabled");
  return `<div class="lmsa-toggle${state ? " " + state : ""}" role="switch" aria-checked="${enabled}" tabindex="0"${disabled ? ' aria-disabled="true"' : ""}></div>`;
};

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

// A section card on a CONVERTED settings tab, mirroring settingsSections() in
// definitions/sections.ts: the card is Obsidian's own group element (`cls` is the only styling
// hook a definition carries, so it holds the card class, the token host and the tab accent), the
// group's `.setting-items` list is the card body, and the header plus the lead paragraph share the
// first row host. `tab` is the accent slug, `rows` are convertedRow()/convertedBlock() hosts.
export const convertedSection = (tab, title, desc, rows, icon, extraCls = "") => {
  if (!icon) {
    throw new Error(`convertedSection("${title}") needs the icon its tab passes to settingsSections`);
  }
  // A card with no description draws its title alone and marks the head row, so the row below it
  // draws no divider: settingsSections() omits the paragraph rather than emitting an empty one.
  return `<div class="setting-group lmsa-ui-card lmsa-settings-section lmsa-settings-root lmsa-tab-${tab}${
    extraCls ? " " + extraCls : ""
  }">
    <div class="setting-items">
      <div class="setting-item lmsa-settings-section-head${desc ? "" : " is-title-only"}">
        <div class="lmsa-settings-section-header">
          <div class="lmsa-settings-section-heading">
            <div class="lmsa-settings-section-icon">${icon}</div>
            <h3 class="lmsa-settings-section-title">${title}</h3>
          </div>
          <div class="lmsa-settings-section-actions"></div>
        </div>
        ${desc ? `<p class="lmsa-settings-section-desc">${desc}</p>` : ""}
      </div>
      ${rows}
    </div>
  </div>`;
};

// A converted row: Obsidian's `.setting-item` host, re-dressed by SettingItem's adopt path.
// `below` is the case where a caller mounts into `settingEl` instead of `controlEl` (RagTab's
// embedding-model selector does this), so the control lands after the control slot and renders
// full width under the row rather than beside it.
export const convertedRow = (name, desc, control, below = "") =>
  `<div class="setting-item lmsa-setting-item">
    <div class="lmsa-setting-item-info">
      <div class="lmsa-setting-item-name">${name}</div>
      <div class="lmsa-setting-item-desc">${desc}</div>
    </div>
    <div class="lmsa-setting-item-control">${control}</div>${below}
  </div>`;

// A converted row that draws a block instead of a name / description / control pair.
export const convertedBlock = (body) =>
  `<div class="setting-item lmsa-settings-section-block">${body}</div>`;

// The card footer, which a converted card carries as its last row: a group has no footer element,
// so the button that used to sit in one is a row that owns its host and keeps the footer class.
export const convertedFooter = (body) =>
  `<div class="setting-item lmsa-settings-section-footer">${body}</div>`;

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

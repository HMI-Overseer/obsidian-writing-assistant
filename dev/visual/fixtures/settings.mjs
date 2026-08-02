import { I } from "./icons.mjs";

// Page names, keyed by the slug that selects the accent. Obsidian draws the name in the page
// titlebar; the per-page description lives on the tab's root list, which no fixture pictures.
export const SETTINGS_TABS = {
  general: "General",
  providers: "Providers",
  retrieval: "Retrieval",
  "knowledge-graph": "Knowledge Graph",
  memories: "Memories",
  commands: "Commands",
  "vault-operations": "Vault Operations",
  advanced: "Advanced",
  benchmark: "Benchmark",
};

// The titlebar Obsidian builds when a settings page is opened: a back button and the page title,
// both inside the page's own `.setting-page-titlebar`.
export const settingsPageTitlebar = (tab) => {
  const name = SETTINGS_TABS[tab];
  if (!name) throw new Error(`Unknown settings tab: ${tab}`);
  return `<div class="setting-page-titlebar">
    <div class="clickable-icon setting-page-back-button">${I.chevronLeft}</div>
    <div class="setting-page-title">${name}</div>
  </div>`;
};

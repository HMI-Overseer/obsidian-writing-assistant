import { I } from "./icons.mjs";

export const SETTINGS_TABS = {
  general: {
    title: "Connection and Context",
    description:
      "Configure how the plugin talks to LLM providers and how much note context is sent with each request.",
  },
  providers: {
    title: "Providers",
    description:
      "Enable the LLM providers you use and manage their credentials and models in one place.",
  },
  retrieval: {
    title: "Retrieval (RAG)",
    description:
      "Automatically find and inject relevant vault content into each chat request using embedding-based search.",
  },
  "knowledge-graph": {
    title: "Knowledge Graph",
    description:
      "Extract entities and relationships from your vault using an LLM to build a semantic knowledge graph.",
  },
  memories: {
    title: "Memories",
    description:
      "Keep standing facts about your work, rules the assistant always follows and context it can recall on demand.",
  },
  commands: {
    title: "Quick Commands",
    description:
      "Create reusable prompt shortcuts that can pull from the current selection or the active note.",
  },
  "vault-operations": {
    title: "Vault Operations",
    description:
      "Control how the assistant is allowed to create, overwrite, move, and trash notes across your vault.",
  },
  advanced: {
    title: "Advanced Controls",
    description:
      "Fine tune context sizing and a few maintenance utilities for local-first workflows.",
  },
  benchmark: {
    title: "Benchmark Models",
    description:
      "Run structured tests to measure response quality and consistency for using plugin built-in functionality.",
  },
};

const NAV_GROUPS = [
  {
    label: "Plugin",
    items: [
      { tab: "general", label: "General", icon: I.gear },
      { tab: "providers", label: "Providers", icon: I.plug },
    ],
  },
  {
    label: "Knowledge",
    items: [
      { tab: "retrieval", label: "RAG", icon: I.search },
      { tab: "knowledge-graph", label: "Graph", icon: I.gitFork },
      { tab: "memories", label: "Memories", icon: I.brain },
    ],
  },
  {
    label: "Config",
    items: [
      { tab: "commands", label: "Commands", icon: I.terminal },
      { tab: "vault-operations", label: "Vault ops", icon: I.shieldCheck },
      { tab: "advanced", label: "Advanced", icon: I.slidersHorizontal },
      { tab: "benchmark", label: "Benchmark", icon: I.flaskConical },
    ],
  },
];

export const settingsRail = (activeTab) =>
  `<div class="lmsa-settings-rail">${NAV_GROUPS.map((group) => {
    const groupActive = group.items.some((item) => item.tab === activeTab);
    return `<div class="lmsa-settings-rail-group${groupActive ? " is-active" : ""}">
      <span class="lmsa-settings-rail-group-label">${group.label}</span>
      ${group.items.map((item) =>
        `<button class="lmsa-settings-rail-item${item.tab === activeTab ? " is-active" : ""}" type="button">
          <span class="lmsa-settings-rail-icon">${item.icon}</span>
          <span class="lmsa-settings-rail-label">${item.label}</span>
        </button>`).join("")}
    </div>`;
  }).join("")}</div>`;

export const settingsPanelHeader = (tab) => {
  const meta = SETTINGS_TABS[tab];
  if (!meta) throw new Error(`Unknown settings tab: ${tab}`);
  return `<div class="lmsa-settings-panel-header">
    <div class="setting-item setting-item-heading lmsa-settings-panel-heading">
      <div class="setting-item-info">
        <div class="setting-item-name">${meta.title}</div>
        <div class="setting-item-description">${meta.description}</div>
      </div>
      <div class="setting-item-control"></div>
    </div>
  </div>`;
};

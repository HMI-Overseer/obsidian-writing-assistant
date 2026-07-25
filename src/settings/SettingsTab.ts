import type { App } from "obsidian";
import { PluginSettingTab, setIcon, Setting } from "obsidian";
import type WritingAssistantChat from "../main";
import { renderAdvancedTab } from "./AdvancedTab";
import { renderCommandsTab } from "./CommandsTab";
import { renderProvidersTab } from "./ProvidersTab";
import { renderGeneralTab } from "./GeneralTab";
import { renderRagTab } from "./RagTab";
import { renderKnowledgeGraphTab } from "./KnowledgeGraphTab";
import { renderMemoriesTab } from "./MemoriesTab";
import { renderBenchmarkTab } from "./BenchmarkTab";
import { renderVaultOpsTab } from "./VaultOpsTab";

type TabName = "General" | "Providers" | "Retrieval" | "Knowledge Graph" | "Memories" | "Commands" | "Vault Operations" | "Advanced" | "Benchmark";

type NavItem = { tab: TabName; rail: string; icon: string };
type NavGroup = { label: string; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  { label: "Plugin", items: [
    { tab: "General",   rail: "General",   icon: "settings" },
    { tab: "Providers", rail: "Providers", icon: "plug" },
  ]},
  { label: "Knowledge", items: [
    { tab: "Retrieval",        rail: "RAG",      icon: "search" },
    { tab: "Knowledge Graph",  rail: "Graph",    icon: "git-fork" },
    { tab: "Memories",         rail: "Memories", icon: "brain" },
  ]},
  { label: "Config", items: [
    { tab: "Commands",         rail: "Commands",  icon: "terminal" },
    { tab: "Vault Operations", rail: "Vault ops", icon: "shield-check" },
    { tab: "Advanced",         rail: "Advanced",  icon: "sliders-horizontal" },
    { tab: "Benchmark",        rail: "Benchmark", icon: "flask-conical" },
  ]},
];

type TabMeta = {
  title: string;
  description: string;
};

const TAB_SLUGS: Record<TabName, string> = {
  "General": "general",
  "Providers": "providers",
  "Retrieval": "retrieval",
  "Knowledge Graph": "knowledge-graph",
  "Memories": "memories",
  "Commands": "commands",
  "Vault Operations": "vault-operations",
  "Advanced": "advanced",
  "Benchmark": "benchmark",
};

const TAB_META: Record<TabName, TabMeta> = {
  "General": {
    title: "Connection and Context",
    description: "Configure how the plugin talks to LLM providers and how much note context is sent with each request.",
  },
  "Providers": {
    title: "Providers",
    description: "Enable the LLM providers you use and manage their credentials and models in one place.",
  },
  "Retrieval": {
    title: "Retrieval (RAG)",
    description: "Automatically find and inject relevant vault content into each chat request using embedding-based search.",
  },
  "Knowledge Graph": {
    title: "Knowledge Graph",
    description: "Extract entities and relationships from your vault using an LLM to build a semantic knowledge graph.",
  },
  "Memories": {
    title: "Memories",
    description: "Keep standing facts about your work, rules the assistant always follows and context it can recall on demand.",
  },
  "Commands": {
    title: "Quick Commands",
    description: "Create reusable prompt shortcuts that can pull from the current selection or the active note.",
  },
  "Vault Operations": {
    title: "Vault Operations",
    description: "Control how the assistant is allowed to create, overwrite, move, and trash notes across your vault.",
  },
  "Advanced": {
    title: "Advanced Controls",
    description: "Fine tune context sizing and a few maintenance utilities for local-first workflows.",
  },
  "Benchmark": {
    title: "Benchmark Models",
    description: "Run structured tests to measure response quality and consistency for using plugin built-in functionality.",
  },
};

export class WritingAssistantSettingTab extends PluginSettingTab {
  private activeTab: TabName = "General";
  private cleanupBenchmark: (() => void) | null = null;
  private cleanupRag: (() => void) | null = null;
  private cleanupKg: (() => void) | null = null;
  private cleanupProviders: (() => void) | null = null;

  constructor(
    app: App,
    private plugin: WritingAssistantChat
  ) {
    super(app, plugin);
  }

  hide(): void {
    this.cleanupBenchmark?.();
    this.cleanupBenchmark = null;
    this.cleanupRag?.();
    this.cleanupRag = null;
    this.cleanupKg?.();
    this.cleanupKg = null;
    this.cleanupProviders?.();
    this.cleanupProviders = null;
  }

  display(): void {
    this.cleanupBenchmark?.();
    this.cleanupBenchmark = null;
    this.cleanupRag?.();
    this.cleanupRag = null;
    this.cleanupKg?.();
    this.cleanupKg = null;
    this.cleanupProviders?.();
    this.cleanupProviders = null;
    const { containerEl } = this;
    const activeMeta = TAB_META[this.activeTab];

    containerEl.empty();
    containerEl.addClass("lmsa-settings-root");

    const shell = containerEl.createDiv({ cls: "lmsa-settings-shell" });
    shell.setAttribute("data-tab", TAB_SLUGS[this.activeTab]);

    const rail = shell.createDiv({ cls: "lmsa-settings-rail" });
    for (const group of NAV_GROUPS) {
      const groupActive = group.items.some((i) => i.tab === this.activeTab);
      const groupEl = rail.createDiv({ cls: "lmsa-settings-rail-group" });
      if (groupActive) groupEl.addClass("is-active");
      groupEl.createSpan({ cls: "lmsa-settings-rail-group-label", text: group.label });
      for (const item of group.items) {
        const button = groupEl.createEl("button", {
          cls: "lmsa-settings-rail-item",
          attr: { type: "button" },
        });
        const iconEl = button.createSpan({ cls: "lmsa-settings-rail-icon" });
        setIcon(iconEl, item.icon);
        button.createSpan({ cls: "lmsa-settings-rail-label", text: item.rail });
        if (item.tab === this.activeTab) {
          button.addClass("is-active");
        }
        button.addEventListener("click", () => {
          this.activeTab = item.tab;
          this.display();
        });
      }
    }

    const stage = shell.createDiv({ cls: "lmsa-settings-stage" });
    const panel = stage.createDiv({ cls: "lmsa-settings-panel lmsa-ui-panel" });

    const panelHeader = panel.createDiv({ cls: "lmsa-settings-panel-header" });
    const panelHeading = new Setting(panelHeader)
      .setName(activeMeta.title)
      .setDesc(activeMeta.description)
      .setHeading();
    panelHeading.settingEl.addClass("lmsa-settings-panel-heading");

    const content = panel.createDiv({ cls: "lmsa-settings-content" });
    const refresh = () => this.display();

    switch (this.activeTab) {
      case "General":
        renderGeneralTab(content, this.plugin);
        break;
      case "Providers":
        this.cleanupProviders = renderProvidersTab(content, this.plugin, refresh);
        break;
      case "Retrieval":
        this.cleanupRag = renderRagTab(content, this.plugin);
        break;
      case "Knowledge Graph":
        this.cleanupKg = renderKnowledgeGraphTab(content, this.plugin);
        break;
      case "Memories":
        renderMemoriesTab(content, this.plugin);
        break;
      case "Commands":
        renderCommandsTab(content, this.plugin, refresh);
        break;
      case "Vault Operations":
        renderVaultOpsTab(content, this.plugin);
        break;
      case "Advanced":
        renderAdvancedTab(content, this.plugin);
        break;
      case "Benchmark":
        this.cleanupBenchmark = renderBenchmarkTab(content, this.plugin, refresh);
        break;
    }
  }
}

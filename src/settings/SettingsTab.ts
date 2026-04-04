import type { App } from "obsidian";
import { PluginSettingTab, Setting } from "obsidian";
import type LMStudioWritingAssistant from "../main";
import { renderAdvancedTab } from "./AdvancedTab";
import { renderCommandsTab } from "./CommandsTab";
import { renderCompletionModelsTab } from "./CompletionModelsTab";
import { renderEmbeddingModelsTab } from "./EmbeddingModelsTab";
import { renderGeneralTab } from "./GeneralTab";
import { renderRagTab } from "./RagTab";
import { renderKnowledgeGraphTab } from "./KnowledgeGraphTab";
import { renderBenchmarkTab } from "./BenchmarkTab";

const MAIN_TABS = ["General", "Completion Models", "Embedding Models", "Retrieval", "Knowledge Graph", "Commands", "Advanced"] as const;
const BENCH_TABS = ["Benchmark"] as const;
type TabName = (typeof MAIN_TABS)[number] | (typeof BENCH_TABS)[number];

type TabMeta = {
  title: string;
  description: string;
};

const TAB_SLUGS: Record<TabName, string> = {
  "General": "general",
  "Completion Models": "completion",
  "Embedding Models": "embedding",
  "Retrieval": "retrieval",
  "Knowledge Graph": "knowledge-graph",
  "Commands": "commands",
  "Advanced": "advanced",
  "Benchmark": "benchmark",
};

const TAB_META: Record<TabName, TabMeta> = {
  "General": {
    title: "Connection and Context",
    description: "Configure how the plugin talks to LM Studio and how much note context is sent with each request.",
  },
  "Completion Models": {
    title: "Completion Model Library",
    description: "Build reusable chat profiles with their own prompts, token budgets, and temperatures.",
  },
  "Embedding Models": {
    title: "Embedding Models",
    description: "Prepare model profiles for semantic search and future retrieval workflows inside the plugin.",
  },
  "Retrieval": {
    title: "Retrieval (RAG)",
    description: "Automatically find and inject relevant vault content into each chat request using embedding-based search.",
  },
  "Knowledge Graph": {
    title: "Knowledge Graph",
    description: "Extract entities and relationships from your vault using an LLM to build a semantic knowledge graph.",
  },
  "Commands": {
    title: "Quick Commands",
    description: "Create reusable prompt shortcuts that can pull from the current selection or the active note.",
  },
  "Advanced": {
    title: "Advanced Controls",
    description: "Fine tune context sizing and a few maintenance utilities for local-first workflows.",
  },
  "Benchmark": {
    title: "Edit Outcome Benchmark",
    description: "Test whether models correctly interpret edit outcome annotations using real LM Studio completions.",
  },
};

export class LMStudioSettingTab extends PluginSettingTab {
  private activeTab: TabName = "General";
  private cleanupBenchmark: (() => void) | null = null;
  private cleanupRag: (() => void) | null = null;
  private cleanupKg: (() => void) | null = null;

  constructor(
    app: App,
    private plugin: LMStudioWritingAssistant
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
  }

  display(): void {
    this.cleanupBenchmark?.();
    this.cleanupBenchmark = null;
    this.cleanupRag?.();
    this.cleanupRag = null;
    this.cleanupKg?.();
    this.cleanupKg = null;
    const { containerEl } = this;
    const activeMeta = TAB_META[this.activeTab];

    containerEl.empty();
    containerEl.addClass("lmsa-settings-root");

    const shell = containerEl.createDiv({ cls: "lmsa-settings-shell" });

    const topbar = shell.createDiv({ cls: "lmsa-settings-topbar lmsa-ui-panel" });

    const nav = topbar.createDiv({ cls: "lmsa-settings-nav" });
    for (const tab of MAIN_TABS) {
      const button = nav.createEl("button", {
        cls: "lmsa-settings-tab-btn",
        attr: { type: "button" },
      });
      button.createEl("span", { cls: "lmsa-settings-tab-label", text: tab });
      if (tab === this.activeTab) {
        button.addClass("is-active");
      }
      button.addEventListener("click", () => {
        this.activeTab = tab;
        this.display();
      });
    }

    const benchNav = topbar.createDiv({ cls: "lmsa-settings-nav lmsa-settings-nav--bench" });
    for (const tab of BENCH_TABS) {
      const button = benchNav.createEl("button", {
        cls: "lmsa-settings-tab-btn",
        attr: { type: "button" },
      });
      button.createEl("span", { cls: "lmsa-settings-tab-label", text: tab });
      if (tab === this.activeTab) {
        button.addClass("is-active");
      }
      button.addEventListener("click", () => {
        this.activeTab = tab;
        this.display();
      });
    }

    shell.setAttribute("data-tab", TAB_SLUGS[this.activeTab]);

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
      case "Completion Models":
        renderCompletionModelsTab(content, this.plugin);
        break;
      case "Embedding Models":
        renderEmbeddingModelsTab(content, this.plugin);
        break;
      case "Retrieval":
        this.cleanupRag = renderRagTab(content, this.plugin);
        break;
      case "Knowledge Graph":
        this.cleanupKg = renderKnowledgeGraphTab(content, this.plugin);
        break;
      case "Commands":
        renderCommandsTab(content, this.plugin, refresh);
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

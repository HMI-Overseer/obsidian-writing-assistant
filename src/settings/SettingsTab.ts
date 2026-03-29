import type { App } from "obsidian";
import { PluginSettingTab } from "obsidian";
import type LMStudioWritingAssistant from "../main";
import { renderAdvancedTab } from "./AdvancedTab";
import { renderCommandsTab } from "./CommandsTab";
import { renderCompletionModelsTab } from "./CompletionModelsTab";
import { renderEmbeddingModelsTab } from "./EmbeddingModelsTab";
import { renderGeneralTab } from "./GeneralTab";
import { renderBenchmarkTab } from "./BenchmarkTab";

const MAIN_TABS = ["General", "Completion Models", "Embedding Models", "Commands", "Advanced"] as const;
const BENCH_TABS = ["Benchmark"] as const;
const TABS = [...MAIN_TABS, ...BENCH_TABS] as const;

type TabName = (typeof TABS)[number];

type TabMeta = {
  title: string;
  description: string;
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

  constructor(
    app: App,
    private plugin: LMStudioWritingAssistant
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const activeMeta = TAB_META[this.activeTab];

    containerEl.empty();
    containerEl.addClass("lmsa-settings-root");

    const shell = containerEl.createDiv({ cls: "lmsa-settings-shell" });

    const topbar = shell.createDiv({ cls: "lmsa-settings-topbar lmsa-ui-panel" });
    const brand = topbar.createDiv({ cls: "lmsa-settings-brand" });
    brand.createEl("div", {
      cls: "lmsa-settings-eyebrow",
      text: "Local-first writing assistant",
    });
    brand.createEl("h2", {
      cls: "lmsa-settings-title",
      text: "Plugin Settings",
    });

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

    const stage = shell.createDiv({ cls: "lmsa-settings-stage" });
    const panel = stage.createDiv({ cls: "lmsa-settings-panel lmsa-ui-panel" });

    const panelHeader = panel.createDiv({ cls: "lmsa-settings-panel-header" });
    panelHeader.createEl("h3", {
      cls: "lmsa-settings-panel-title",
      text: activeMeta.title,
    });
    panelHeader.createEl("p", {
      cls: "lmsa-settings-panel-desc",
      text: activeMeta.description,
    });

    const content = panel.createDiv({ cls: "lmsa-settings-content" });
    const refresh = () => this.display();

    switch (this.activeTab) {
      case "General":
        renderGeneralTab(content, this.plugin);
        break;
      case "Completion Models":
        renderCompletionModelsTab(content, this.plugin, refresh);
        break;
      case "Embedding Models":
        renderEmbeddingModelsTab(content, this.plugin, refresh);
        break;
      case "Commands":
        renderCommandsTab(content, this.plugin, refresh);
        break;
      case "Advanced":
        renderAdvancedTab(content, this.plugin);
        break;
      case "Benchmark":
        renderBenchmarkTab(content, this.plugin, refresh);
        break;
    }
  }
}

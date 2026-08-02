import type { App, SettingDefinitionItem, SettingDefinitionPage } from "obsidian";
import { PluginSettingTab } from "obsidian";
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
import type { TabPageRenderer } from "./definitions/ImperativeTabPage";
import { ImperativeTabPage } from "./definitions/ImperativeTabPage";

type TabName = "General" | "Providers" | "Retrieval" | "Knowledge Graph" | "Memories" | "Commands" | "Vault Operations" | "Advanced" | "Benchmark";

// Selects the per-tab accent in tokens.css. Obsidian indexes pages by name, so this is styling
// only; it is never a navigation target.
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

// Shown on each page's entry in the tab's root list, and indexed for settings search.
const TAB_DESCRIPTIONS: Record<TabName, string> = {
  "General": "Configure how the plugin talks to LLM providers and how much note context is sent with each request.",
  "Providers": "Enable the LLM providers you use and manage their credentials and models in one place.",
  "Retrieval": "Automatically find and inject relevant vault content into each chat request using embedding-based search.",
  "Knowledge Graph": "Extract entities and relationships from your vault using an LLM to build a semantic knowledge graph.",
  "Memories": "Keep standing facts about your work, rules the assistant always follows and context it can recall on demand.",
  "Commands": "Create reusable prompt shortcuts that can pull from the current selection or the active note.",
  "Vault Operations": "Control how the assistant is allowed to create, overwrite, move, and trash notes across your vault.",
  "Advanced": "Fine tune context sizing and a few maintenance utilities for local-first workflows.",
  "Benchmark": "Run structured tests to measure response quality and consistency for using plugin built-in functionality.",
};

export class WritingAssistantSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: WritingAssistantChat
  ) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const page = (name: TabName, render: TabPageRenderer): SettingDefinitionPage => ({
      type: "page",
      name,
      desc: TAB_DESCRIPTIONS[name],
      page: () => new ImperativeTabPage(name, TAB_SLUGS[name], render),
    });

    return [
      page("General", (el) => renderGeneralTab(el, this.plugin)),
      page("Providers", (el, refresh) => renderProvidersTab(el, this.plugin, refresh)),
      page("Retrieval", (el) => renderRagTab(el, this.plugin)),
      page("Knowledge Graph", (el) => renderKnowledgeGraphTab(el, this.plugin)),
      page("Memories", (el) => renderMemoriesTab(el, this.plugin)),
      page("Commands", (el, refresh) => renderCommandsTab(el, this.plugin, refresh)),
      page("Vault Operations", (el) => renderVaultOpsTab(el, this.plugin)),
      page("Advanced", (el) => renderAdvancedTab(el, this.plugin)),
      page("Benchmark", (el, refresh) => renderBenchmarkTab(el, this.plugin, refresh)),
    ];
  }
}

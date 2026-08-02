import type {
  App,
  SettingDefinitionGroup,
  SettingDefinitionItem,
  SettingDefinitionPage,
} from "obsidian";
import { PluginSettingTab } from "obsidian";
import type WritingAssistantChat from "../main";
import { advancedTabSections } from "./AdvancedTab";
import { commandsTabSections } from "./CommandsTab";
import { renderProvidersTab } from "./ProvidersTab";
import { generalTabSections } from "./GeneralTab";
import { ragTabSections } from "./RagTab";
import { knowledgeGraphTabSections } from "./KnowledgeGraphTab";
import { memoriesTabSections } from "./MemoriesTab";
import { renderBenchmarkTab } from "./BenchmarkTab";
import { vaultOpsTabSections } from "./VaultOpsTab";
import type { TabPageRenderer } from "./definitions/ImperativeTabPage";
import { ImperativeTabPage } from "./definitions/ImperativeTabPage";
import type { SettingsSection } from "./definitions/sections";
import { settingsSections } from "./definitions/sections";

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
    // Puts the design tokens in scope for the root list, the same hook the pages carry.
    this.containerEl.addClass("lmsa-settings-root");
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    // A page whose rows are still drawn by the tab renderer it has always had. Only the page name
    // reaches settings search: the index walker descends into `items`, never into a `page` factory.
    const page = (name: TabName, render: TabPageRenderer): SettingDefinitionPage => ({
      type: "page",
      name,
      desc: TAB_DESCRIPTIONS[name],
      page: () => new ImperativeTabPage(name, TAB_SLUGS[name], render),
    });

    // A converted page: Obsidian renders the rows and indexes every one of them by name.
    const converted = (name: TabName, sections: SettingsSection[]): SettingDefinitionPage => ({
      type: "page",
      name,
      desc: TAB_DESCRIPTIONS[name],
      items: settingsSections(TAB_SLUGS[name], sections),
    });

    // Groups render their pages inline under a heading, so this is the rail's grouping without the
    // extra navigation level nesting would cost. Search is unaffected: both index walkers descend
    // through a group carrying the page path through unchanged.
    const group = (heading: string, pages: SettingDefinitionPage[]): SettingDefinitionGroup => ({
      type: "group",
      heading,
      cls: "lmsa-settings-nav-group",
      items: pages,
    });

    return [
      group("Plugin", [
        converted("General", generalTabSections(this.plugin)),
        page("Providers", (el, refresh) => renderProvidersTab(el, this.plugin, refresh)),
      ]),
      group("Knowledge", [
        converted("Retrieval", ragTabSections(this.plugin, () => this.refreshDomState())),
        converted(
          "Knowledge Graph",
          knowledgeGraphTabSections(this.plugin, () => this.refreshDomState()),
        ),
        converted("Memories", memoriesTabSections(this.plugin)),
      ]),
      group("Config", [
        converted("Commands", commandsTabSections(this.plugin)),
        converted("Vault Operations", vaultOpsTabSections(this.plugin)),
        converted("Advanced", advancedTabSections(this.plugin)),
        page("Benchmark", (el, refresh) => renderBenchmarkTab(el, this.plugin, refresh)),
      ]),
    ];
  }
}

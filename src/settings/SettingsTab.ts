import type { App } from "obsidian";
import { PluginSettingTab } from "obsidian";
import type LMStudioWritingAssistant from "../main";
import { renderAdvancedTab } from "./AdvancedTab";
import { renderCommandsTab } from "./CommandsTab";
import { renderCompletionModelsTab } from "./CompletionModelsTab";
import { renderEmbeddingModelsTab } from "./EmbeddingModelsTab";
import { renderGeneralTab } from "./GeneralTab";

const TABS = ["General", "Completion Models", "Embedding Models", "Commands", "Advanced"] as const;

type TabName = (typeof TABS)[number];

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
    containerEl.empty();
    containerEl.addClass("lmsa-settings-root");

    const nav = containerEl.createDiv({ cls: "lmsa-settings-nav" });
    for (const tab of TABS) {
      const button = nav.createEl("button", {
        cls: "lmsa-settings-tab-btn",
        text: tab,
      });
      if (tab === this.activeTab) {
        button.addClass("is-active");
      }
      button.addEventListener("click", () => {
        this.activeTab = tab;
        this.display();
      });
    }

    const content = containerEl.createDiv({ cls: "lmsa-settings-content" });
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
    }
  }
}

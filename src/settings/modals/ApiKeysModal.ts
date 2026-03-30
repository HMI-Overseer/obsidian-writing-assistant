import type { App } from "obsidian";
import { Modal, Setting } from "obsidian";
import type LMStudioWritingAssistant from "../../main";

/**
 * Modal for managing API keys across all providers that require them.
 * Opened from the General settings tab.
 */
export class ApiKeysModal extends Modal {
  constructor(
    app: App,
    private plugin: LMStudioWritingAssistant
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    const { settings } = this.plugin;

    contentEl.addClass("lmsa-modal");
    contentEl.createEl("h2", { text: "Provider API Keys" });
    contentEl.createEl("p", {
      cls: "lmsa-modal-desc",
      text: "API keys are stored locally in the plugin's data file and never sent anywhere except the provider's own API.",
    });

    // ── Anthropic ──────────────────────────────────────────────────────
    new Setting(contentEl)
      .setName("Anthropic")
      .setDesc("Used for Claude models.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "off";
        text
          .setPlaceholder("sk-ant-...")
          .setValue(settings.providerSettings.anthropic.apiKey)
          .onChange(async (value) => {
            settings.providerSettings.anthropic.apiKey = value;
            await this.plugin.saveSettings();
          });
      });

    // ── OpenAI ─────────────────────────────────────────────────────────
    new Setting(contentEl)
      .setName("OpenAI")
      .setDesc("Used for GPT models. (Coming soon)")
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "off";
        text
          .setPlaceholder("sk-...")
          .setValue(settings.providerSettings.openai.apiKey)
          .onChange(async (value) => {
            settings.providerSettings.openai.apiKey = value;
            await this.plugin.saveSettings();
          });
      });

    // ── Close button ───────────────────────────────────────────────────
    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText("Done")
        .setCta()
        .onClick(() => this.close())
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

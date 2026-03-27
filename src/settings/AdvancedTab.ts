import { Notice, Setting } from "obsidian";
import type LMStudioWritingAssistant from "../main";
import { createSettingsSection } from "./ui";

export function renderAdvancedTab(container: HTMLElement, plugin: LMStudioWritingAssistant): void {
  const context = createSettingsSection(
    container,
    "Context Budget",
    "Keep prompts lean when you are working in large notes or experimenting with tighter local model limits."
  );

  new Setting(context.bodyEl)
    .setName("Maximum note context characters")
    .setDesc(
      "When note context is enabled, the active note is trimmed to this many characters before it is added to the system prompt."
    )
    .addText((text) =>
      text
        .setPlaceholder("12000")
        .setValue(String(plugin.settings.maxContextChars))
        .onChange(async (value) => {
          const parsed = parseInt(value, 10);
          if (!Number.isNaN(parsed) && parsed > 0) {
            plugin.settings.maxContextChars = parsed;
            await plugin.saveSettings();
          }
        })
    );

  const utilities = createSettingsSection(
    container,
    "Utilities",
    "Small maintenance actions for checking or sharing the local connection setup."
  );

  new Setting(utilities.bodyEl)
    .setName("Copy LM Studio endpoint")
    .setDesc("Copies the configured LM Studio URL to your clipboard.")
    .addButton((button) => {
      button.setButtonText("Copy URL");
      button.buttonEl.addClass("lmsa-btn-secondary", "lmsa-ui-btn", "lmsa-ui-btn-secondary");
      button.onClick(async () => {
        try {
          await navigator.clipboard.writeText(plugin.settings.lmStudioUrl);
          new Notice("LM Studio URL copied.");
        } catch {
          new Notice("Clipboard access is not available in this view.");
        }
      });
    });

  utilities.bodyEl.createEl("div", {
    cls: "lmsa-advanced-note",
    text: "Tip: if you rely on the Node.js transport, LM Studio does not need browser CORS enabled.",
  });
}

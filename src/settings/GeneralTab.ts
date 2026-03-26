import { Setting } from "obsidian";
import type LMStudioWritingAssistant from "../main";

export function renderGeneralTab(container: HTMLElement, plugin: LMStudioWritingAssistant): void {
  container.createEl("p", {
    cls: "lmsa-tab-desc",
    text: "Configure the LM Studio connection and the default context behavior for the chat view.",
  });

  container.createEl("h3", { text: "Connection" });

  new Setting(container)
    .setName("LM Studio URL")
    .setDesc("Base URL for the LM Studio server.")
    .addText((text) =>
      text
        .setPlaceholder("http://localhost:1234/v1")
        .setValue(plugin.settings.lmStudioUrl)
        .onChange(async (value) => {
          plugin.settings.lmStudioUrl = value.replace(/\/$/, "");
          await plugin.saveSettings();
        })
    );

  new Setting(container)
    .setName("Bypass CORS via Node.js")
    .setDesc(
      "Use Electron's Node.js HTTP stack instead of the browser fetch API. Recommended because it avoids needing CORS enabled in LM Studio."
    )
    .addToggle((toggle) =>
      toggle.setValue(plugin.settings.bypassCors).onChange(async (value) => {
        plugin.settings.bypassCors = value;
        await plugin.saveSettings();
      })
    );

  container.createEl("h3", { text: "Context" });

  new Setting(container)
    .setName("Include active note as context")
    .setDesc(
      "Append the content of the currently open note to the system prompt before each request."
    )
    .addToggle((toggle) =>
      toggle.setValue(plugin.settings.includeNoteContext).onChange(async (value) => {
        plugin.settings.includeNoteContext = value;
        await plugin.saveSettings();
      })
    );
}

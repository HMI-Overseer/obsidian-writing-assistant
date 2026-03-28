import { Setting } from "obsidian";
import { normalizeLMStudioBaseUrl } from "../api";
import type LMStudioWritingAssistant from "../main";
import { createSettingsSection } from "./ui";

export function renderGeneralTab(container: HTMLElement, plugin: LMStudioWritingAssistant): void {
  const connection = createSettingsSection(
    container,
    "Connection",
    "Point the plugin at your LM Studio server and choose how requests should be routed from Obsidian."
  );

  new Setting(connection.bodyEl)
    .setName("LM Studio URL")
    .setDesc(
      "Base URL for the LM Studio server. You can enter the server root, `/v1`, or `/api/v1`; the plugin will resolve the right endpoint for each request."
    )
    .addText((text) =>
      text
        .setPlaceholder("http://localhost:1234")
        .setValue(plugin.settings.lmStudioUrl)
        .onChange(async (value) => {
          plugin.settings.lmStudioUrl = normalizeLMStudioBaseUrl(value);
          await plugin.saveSettings();
        })
    );

  new Setting(connection.bodyEl)
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

  const context = createSettingsSection(
    container,
    "Context",
    "Decide how much of the current note should travel with each request so chat responses stay grounded in your writing."
  );

  new Setting(context.bodyEl)
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

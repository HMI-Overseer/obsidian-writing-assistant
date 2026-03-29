import { Setting } from "obsidian";
import type LMStudioWritingAssistant from "../main";
import { createSettingsSection } from "./ui";

export function renderGeneralTab(container: HTMLElement, plugin: LMStudioWritingAssistant): void {
  const context = createSettingsSection(
    container,
    "Active Note",
    "Include your currently open note as context so chat responses stay grounded in your writing.",
    { icon: "file-text" }
  );

  new Setting(context.bodyEl)
    .setName("Include active note as context")
    .setDesc(
      "Send the content of the currently open note alongside each request."
    )
    .addToggle((toggle) =>
      toggle.setValue(plugin.settings.includeNoteContext).onChange(async (value) => {
        plugin.settings.includeNoteContext = value;
        await plugin.saveSettings();
      })
    );
}

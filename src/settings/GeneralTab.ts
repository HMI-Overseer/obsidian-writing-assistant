import type LMStudioWritingAssistant from "../main";
import { ApiKeysModal } from "./modals";
import { createSettingsSection, SettingItem } from "./ui";

export function renderGeneralTab(container: HTMLElement, plugin: LMStudioWritingAssistant): void {
  // ── Provider API Keys ──────────────────────────────────────────────
  const keys = createSettingsSection(
    container,
    "Provider API Keys",
    "Manage API keys for cloud providers like Anthropic and OpenAI. Keys are stored locally and never shared.",
    { icon: "key-round" }
  );

  new SettingItem(keys.bodyEl)
    .setName("Configure API keys")
    .setDesc("Open a window to enter or update your provider API keys.")
    .addButton((button) =>
      button
        .setButtonText("Manage keys")
        .setCta()
        .onClick(() => {
          new ApiKeysModal(plugin.app, plugin).open();
        })
    );

  // ── Active Note ────────────────────────────────────────────────────
  const context = createSettingsSection(
    container,
    "Active Note",
    "Include your currently open note as context so chat responses stay grounded in your writing.",
    { icon: "file-text" }
  );

  new SettingItem(context.bodyEl)
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

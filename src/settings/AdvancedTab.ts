import type LMStudioWritingAssistant from "../main";
import { createSettingsSection, SettingItem } from "./ui";

export function renderAdvancedTab(container: HTMLElement, plugin: LMStudioWritingAssistant): void {
  const editing = createSettingsSection(
    container,
    "Document Editing",
    "Configure how AI-proposed edits are matched against your notes.",
    { icon: "file-diff" }
  );

  new SettingItem(editing.bodyEl)
    .setName("Diff context lines")
    .setDesc(
      "Number of lines shown above and below each diff hunk for context."
    )
    .addText((text) =>
      text
        .setPlaceholder("3")
        .setValue(String(plugin.settings.diffContextLines))
        .onChange(async (value) => {
          const parsed = parseInt(value, 10);
          if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 20) {
            plugin.settings.diffContextLines = parsed;
            await plugin.saveSettings();
          }
        })
    );

  new SettingItem(editing.bodyEl)
    .setName("Minimum match confidence")
    .setDesc(
      "Fuzzy match confidence threshold (0–1). Matches below this score are flagged as unresolved. Default: 0.7"
    )
    .addText((text) =>
      text
        .setPlaceholder("0.7")
        .setValue(String(plugin.settings.diffMinMatchConfidence))
        .onChange(async (value) => {
          const parsed = parseFloat(value);
          if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 1) {
            plugin.settings.diffMinMatchConfidence = parsed;
            await plugin.saveSettings();
          }
        })
    );

}

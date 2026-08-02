import type WritingAssistantChat from "../main";
import { DEFAULT_MAX_TOOL_ROUNDS } from "../constants";
import type { SettingsSection } from "./definitions/sections";
import { settingRow } from "./definitions/sections";

export function advancedTabSections(plugin: WritingAssistantChat): SettingsSection[] {
  return [
    {
      name: "Agentic mode",
      desc: "Allow the model to call tools: search your vault, read notes, and apply structured edits across multiple reasoning rounds.",
      icon: "bot",
      rows: [
        settingRow(
          "Enable agentic mode",
          "Vault search and edit tools become available. The model can read notes and iterate before producing a response.",
          (item) =>
            item.addToggle((toggle) =>
              toggle.setValue(plugin.settings.agenticMode).onChange(async (value) => {
                plugin.settings.agenticMode = value;
                await plugin.saveSettings();
              })
            )
        ),
        settingRow(
          "Max tool rounds",
          `Maximum read-only tool rounds per turn (vault search and outline inspection before the model responds or edits). Default: ${DEFAULT_MAX_TOOL_ROUNDS}.`,
          (item) =>
            item.addText((text) =>
              text
                .setPlaceholder(String(DEFAULT_MAX_TOOL_ROUNDS))
                .setValue(String(plugin.settings.maxToolRounds))
                .onChange(async (value) => {
                  const parsed = parseInt(value, 10);
                  if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 50) {
                    plugin.settings.maxToolRounds = parsed;
                    await plugin.saveSettings();
                  }
                })
            )
        ),
      ],
    },
    {
      name: "Document Editing",
      desc: "Configure how AI-proposed edits are matched against your notes.",
      icon: "file-diff",
      rows: [
        settingRow(
          "Diff context lines",
          "Number of lines shown above and below each diff hunk for context.",
          (item) =>
            item.addText((text) =>
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
            )
        ),
        settingRow(
          "Minimum match confidence",
          "Fuzzy match confidence threshold (0–1). Matches below this score are flagged as unresolved. Default: 0.7",
          (item) =>
            item.addText((text) =>
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
            )
        ),
      ],
    },
  ];
}

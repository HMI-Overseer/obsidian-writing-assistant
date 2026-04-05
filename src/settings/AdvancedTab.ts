import type LMStudioWritingAssistant from "../main";
import { EDIT_SYSTEM_PROMPT } from "../editing/editSystemPrompt";
import { TOOL_EDIT_SYSTEM_PROMPT } from "../tools/editing/systemPrompt";
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

  // ── System prompt prefixes ──────────────────────────────────────────────

  const prompts = createSettingsSection(
    container,
    "System prompt prefixes",
    "These prompts are prepended before your custom prompt (set in the chat popover). Leave empty to use only your custom prompt.",
    { icon: "message-square" }
  );

  renderPromptPrefixSetting(
    prompts.bodyEl, plugin, "Plan mode prefix",
    "Prepended before your custom prompt in plan mode.",
    "planSystemPromptPrefix", ""
  );

  renderPromptPrefixSetting(
    prompts.bodyEl, plugin, "Chat mode prefix",
    "Prepended before your custom prompt in chat mode.",
    "chatSystemPromptPrefix", ""
  );

  renderPromptPrefixSetting(
    prompts.bodyEl, plugin, "Edit mode prefix (tool use)",
    "Used when the model supports native tool/function calling.",
    "editToolSystemPromptPrefix", TOOL_EDIT_SYSTEM_PROMPT
  );

  renderPromptPrefixSetting(
    prompts.bodyEl, plugin, "Edit mode prefix (text fallback)",
    "Used when the model does not support tool use (SEARCH/REPLACE blocks).",
    "editFallbackSystemPromptPrefix", EDIT_SYSTEM_PROMPT
  );
}

type PromptPrefixKey =
  | "planSystemPromptPrefix"
  | "chatSystemPromptPrefix"
  | "editToolSystemPromptPrefix"
  | "editFallbackSystemPromptPrefix";

function renderPromptPrefixSetting(
  container: HTMLElement,
  plugin: LMStudioWritingAssistant,
  name: string,
  desc: string,
  key: PromptPrefixKey,
  defaultValue: string,
): void {
  let textareaEl: HTMLTextAreaElement;

  new SettingItem(container)
    .setName(name)
    .setDesc(desc)
    .addTextArea((textarea) => {
      textareaEl = textarea.inputEl;
      textareaEl.rows = 6;
      textareaEl.classList.add("lmsa-monospace");
      textarea
        .setPlaceholder("No prefix — using your custom prompt only")
        .setValue(plugin.settings[key])
        .onChange(async (value) => {
          plugin.settings[key] = value;
          await plugin.saveSettings();
        });
    })
    .addButton((btn) =>
      btn.setButtonText("Reset to default").onClick(async () => {
        plugin.settings[key] = defaultValue;
        await plugin.saveSettings();
        textareaEl.value = defaultValue;
      })
    );
}

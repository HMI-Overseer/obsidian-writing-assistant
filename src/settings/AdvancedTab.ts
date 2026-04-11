import type WritingAssistantChat from "../main";
import { EDIT_SYSTEM_PROMPT } from "../editing/regexEditSystemPrompt";
import { TOOL_EDIT_SYSTEM_PROMPT } from "../tools/editing/systemPrompt";
import {
  DEFAULT_CHAT_SYSTEM_PROMPT_PREFIX,
  DEFAULT_MAX_TOOL_ROUNDS_CHAT,
  DEFAULT_MAX_TOOL_ROUNDS_EDIT,
  DEFAULT_PLAN_SYSTEM_PROMPT_PREFIX,
} from "../constants";
import { createSettingsSection, SettingItem } from "./ui";

export function renderAdvancedTab(container: HTMLElement, plugin: WritingAssistantChat): void {
  const agentic = createSettingsSection(
    container,
    "Agentic mode",
    "Allow the model to call tools: search your vault, read notes, and apply structured edits across multiple reasoning rounds.",
    { icon: "bot" }
  );

  new SettingItem(agentic.bodyEl)
    .setName("Enable agentic mode")
    .setDesc(
      "Vault search and edit tools become available. The model can read notes and iterate before producing a response."
    )
    .addToggle((toggle) =>
      toggle.setValue(plugin.settings.agenticMode).onChange(async (value) => {
        plugin.settings.agenticMode = value;
        await plugin.saveSettings();
      })
    );

  new SettingItem(agentic.bodyEl)
    .setName("Max tool rounds — edit mode")
    .setDesc(
      `Maximum read-only tool rounds when editing a document (outline inspection before writing). Default: ${DEFAULT_MAX_TOOL_ROUNDS_EDIT}.`
    )
    .addText((text) =>
      text
        .setPlaceholder(String(DEFAULT_MAX_TOOL_ROUNDS_EDIT))
        .setValue(String(plugin.settings.maxToolRoundsEdit))
        .onChange(async (value) => {
          const parsed = parseInt(value, 10);
          if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 50) {
            plugin.settings.maxToolRoundsEdit = parsed;
            await plugin.saveSettings();
          }
        })
    );

  new SettingItem(agentic.bodyEl)
    .setName("Max tool rounds — chat/plan mode")
    .setDesc(
      `Maximum read-only tool rounds when searching the vault in chat or plan mode. Default: ${DEFAULT_MAX_TOOL_ROUNDS_CHAT}.`
    )
    .addText((text) =>
      text
        .setPlaceholder(String(DEFAULT_MAX_TOOL_ROUNDS_CHAT))
        .setValue(String(plugin.settings.maxToolRoundsChat))
        .onChange(async (value) => {
          const parsed = parseInt(value, 10);
          if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 50) {
            plugin.settings.maxToolRoundsChat = parsed;
            await plugin.saveSettings();
          }
        })
    );

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
    "planSystemPromptPrefix", DEFAULT_PLAN_SYSTEM_PROMPT_PREFIX
  );

  renderPromptPrefixSetting(
    prompts.bodyEl, plugin, "Chat mode prefix",
    "Prepended before your custom prompt in chat mode.",
    "chatSystemPromptPrefix", DEFAULT_CHAT_SYSTEM_PROMPT_PREFIX
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
  plugin: WritingAssistantChat,
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

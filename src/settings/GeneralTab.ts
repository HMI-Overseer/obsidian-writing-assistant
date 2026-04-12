import { setIcon } from "obsidian";
import type WritingAssistantChat from "../main";
import { ApiKeysModal, ApiKeysDisclaimerModal } from "./modals";
import { createSettingsSection, SettingItem } from "./ui";

function openApiKeysWithDisclaimer(plugin: WritingAssistantChat): void {
  if (plugin.settings.apiKeysDisclaimerAccepted) {
    new ApiKeysModal(plugin.app, plugin).open();
    return;
  }
  new ApiKeysDisclaimerModal(plugin.app, plugin, () => {
    new ApiKeysModal(plugin.app, plugin).open();
  }).open();
}

export function renderGeneralTab(container: HTMLElement, plugin: WritingAssistantChat): void {
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
          openApiKeysWithDisclaimer(plugin);
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

  // ── Support ─────────────────────────────────────────────────────────
  const support = createSettingsSection(
    container,
    "Support",
    "This plugin and all of its features are, and will always be, free. If it helped you get closer to achieving your creative goals, you can support this project in the following ways.",
    { icon: "heart" }
  );

  const grid = support.bodyEl.createDiv({ cls: "lmsa-support-grid" });

  const card = grid.createDiv({ cls: "lmsa-support-card" });
  card.addEventListener("click", () => window.open("https://buymeacoffee.com/resolvepublic"));

  const iconEl = card.createDiv({ cls: "lmsa-support-card-icon" });
  setIcon(iconEl, "coffee");

  const textEl = card.createDiv({ cls: "lmsa-support-card-text" });
  textEl.createDiv({ cls: "lmsa-support-card-name", text: "Buy Me a Coffee" });
  textEl.createDiv({ cls: "lmsa-support-card-desc", text: "One-time support" });
}

import { setIcon } from "obsidian";
import type WritingAssistantChat from "../main";
import { DEFAULT_SETTINGS } from "../constants";
import { createSettingsSection, SettingItem } from "./ui";

const MIN_CONTEXT_CHARS = 1000;
const MAX_CONTEXT_CHARS = 200000;

// API keys moved into the Providers tab's per-provider cards, where each key
// sits next to the provider it unlocks (the disclaimer gate moved with them).

export function renderGeneralTab(container: HTMLElement, plugin: WritingAssistantChat): void {
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

  new SettingItem(context.bodyEl)
    .setName("Include local attachments as context when supported")
    .setDesc(
      "When a note is attached and the active model supports vision, send supported local image embeds from that note as extra context."
    )
    .addToggle((toggle) =>
      toggle.setValue(plugin.settings.includeLocalAttachmentsAsContext).onChange(async (value) => {
        plugin.settings.includeLocalAttachmentsAsContext = value;
        await plugin.saveSettings();
      })
    );

  new SettingItem(context.bodyEl)
    .setName("Note context limit")
    .setDesc(
      `Maximum characters of note text sent as context, ${MIN_CONTEXT_CHARS}–${MAX_CONTEXT_CHARS} (default: ${DEFAULT_SETTINGS.maxContextChars}). Longer notes are trimmed; continuation commands keep the ending.`
    )
    .addText((text) =>
      text
        .setPlaceholder(String(DEFAULT_SETTINGS.maxContextChars))
        .setValue(String(plugin.settings.maxContextChars))
        .onChange(async (value) => {
          const parsed = parseInt(value, 10);
          if (!Number.isNaN(parsed) && parsed >= MIN_CONTEXT_CHARS && parsed <= MAX_CONTEXT_CHARS) {
            plugin.settings.maxContextChars = parsed;
            await plugin.saveSettings();
          }
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

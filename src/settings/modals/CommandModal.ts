import type { App } from "obsidian";
import { Modal, Notice, setIcon } from "obsidian";
import { SettingItem } from "../ui";
import type { CustomCommand } from "../../shared/types";
import { generateId } from "../../utils";

/** Curated palette of writing-relevant Lucide icons. */
const COMMAND_ICON_PALETTE = [
  "wand", "scissors", "pencil", "pen-line", "eraser",
  "spell-check", "type", "text", "file-text", "book-open",
  "lightbulb", "sparkles", "star", "eye", "message-circle",
  "list", "arrow-right", "minimize-2", "unfold-vertical", "replace",
  "brain", "search", "check", "bookmark", "hash",
] as const;

export class CommandModal extends Modal {
  private command: CustomCommand;

  constructor(
    app: App,
    source: CustomCommand | null,
    private onSave: (command: CustomCommand) => void
  ) {
    super(app);
    this.command = source
      ? { ...source }
      : {
          id: generateId(),
          name: "",
          prompt: "",
        };
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("lmsa-modal");
    contentEl.createEl("h2", {
      text: this.command.name ? `Edit: ${this.command.name}` : "Add command",
    });

    new SettingItem(contentEl)
      .setName("Command name")
      .setDesc("This appears as a quick-action button in the chat view.")
      .addText((text) =>
        text
          .setPlaceholder("Tighten dialogue")
          .setValue(this.command.name)
          .onChange((value) => (this.command.name = value))
      );

    // ── Icon picker ────────────────────────────────────────────────────

    const iconSetting = new SettingItem(contentEl);
    iconSetting.setName("Icon");
    iconSetting.setDesc("Displayed in the context menu and command list.");

    const gridEl = iconSetting.controlEl.createDiv({ cls: "lmsa-icon-picker-grid" });
    const cellEls: HTMLElement[] = [];

    const selectedIcon = this.command.icon ?? "wand";

    for (const iconName of COMMAND_ICON_PALETTE) {
      const cell = gridEl.createDiv({ cls: "lmsa-icon-picker-cell" });
      setIcon(cell, iconName);

      if (iconName === selectedIcon) {
        cell.addClass("is-selected");
      }

      cell.addEventListener("click", () => {
        for (const el of cellEls) el.removeClass("is-selected");
        cell.addClass("is-selected");
        this.command.icon = iconName;
      });

      cellEls.push(cell);
    }

    // ── Prompt template ────────────────────────────────────────────────

    new SettingItem(contentEl)
      .setName("Prompt template")
      .setDesc("Supports {{selection}} and {{note}} placeholders.")
      .addTextArea((text) => {
        text
          .setPlaceholder("Rewrite {{selection}} to sound sharper while preserving the meaning.")
          .setValue(this.command.prompt)
          .onChange((value) => (this.command.prompt = value));
        text.inputEl.rows = 8;
        text.inputEl.addClass("lmsa-input-full");
      });

    new SettingItem(contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText("Save")
          .setCta()
          .onClick(() => {
            if (!this.command.name.trim()) {
              new Notice("Please enter a command name.");
              return;
            }
            if (!this.command.prompt.trim()) {
              new Notice("Please enter a prompt template.");
              return;
            }
            this.onSave(this.command);
            this.close();
          })
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

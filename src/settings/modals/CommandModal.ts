import type { App } from "obsidian";
import { Modal, Notice } from "obsidian";
import { SettingItem } from "../ui";
import type { CustomCommand } from "../../shared/types";
import { generateId } from "../../utils";

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
          autoInsert: false,
        };
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("lmsa-modal");
    contentEl.createEl("h2", {
      text: this.command.name ? `Edit: ${this.command.name}` : "Add Command",
    });

    new SettingItem(contentEl)
      .setName("Command name")
      .setDesc("This appears as a quick-action button in the chat view.")
      .addText((text) =>
        text
          .setPlaceholder("e.g. Tighten dialogue")
          .setValue(this.command.name)
          .onChange((value) => (this.command.name = value))
      );

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
      .setName("Auto insert response")
      .setDesc(
        "Insert the assistant response into the current note automatically after the command completes."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.command.autoInsert)
          .onChange((value) => (this.command.autoInsert = value))
      );

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

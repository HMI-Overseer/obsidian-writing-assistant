import type { App } from "obsidian";
import { Modal, Notice } from "obsidian";
import { SettingItem } from "../ui";
import type { Memory, MemoryType } from "../../shared/types";
import {
  memoryValidationMessage,
  validateMemoryForm,
} from "../../memory/settingsEdits";
import {
  MEMORY_CONTENT_MAX_CODE_POINTS,
  MEMORY_DESCRIPTION_MAX_CODE_POINTS,
} from "../../memory/validation";

const MEMORY_TYPE_OPTIONS: ReadonlyArray<{ value: MemoryType; label: string }> = [
  { value: "rule", label: "Rule" },
  { value: "context", label: "Context" },
];

/**
 * Add or edit one memory. Identity is the normalized name, so this modal doubles
 * as the rename surface: `source` carries the pre-edit name, and the collision
 * check excludes it (a re-save with the same name is legal, a rename onto a
 * sibling is not).
 *
 * Validation is shared with the `add_memory` tool
 * runs, so a record a user can save is a record the model could have proposed.
 * The `enabled` switch is deliberately absent: it lives on the tab row, where
 * turning an entry off is one click rather than a modal round trip.
 */
export class MemoryModal extends Modal {
  private readonly editingName: string | null;
  private readonly enabled: boolean;
  private name: string;
  private type: MemoryType;
  private description: string;
  private content: string;

  constructor(
    app: App,
    source: Memory | null,
    private readonly existing: readonly Memory[],
    private readonly onSave: (memory: Memory) => void
  ) {
    super(app);
    this.editingName = source?.name ?? null;
    // An edit keeps the entry's own switch (the row's toggle owns `enabled`). A
    // record the user authors here starts on: authoring it is the opt-in, the
    // same reading applies to an approved model-proposed add. Only the
    // bundled defaults ship off.
    this.enabled = source?.enabled ?? true;
    this.name = source?.name ?? "";
    this.type = source?.type ?? "rule";
    this.description = source?.description ?? "";
    this.content = source?.content ?? "";
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("lmsa-modal");
    contentEl.createEl("h2", {
      text: this.editingName ? `Edit: ${this.editingName}` : "Add memory",
    });

    new SettingItem(contentEl)
      .setName("Name")
      .setDesc(
        "Lowercase letters, numbers, and hyphens, such as no-emdashes. This is the memory's identity and the handle the model recalls it by."
      )
      .addText((text) => text.setValue(this.name).onChange((value) => (this.name = value)));

    new SettingItem(contentEl)
      .setName("Type")
      .setDesc(
        "A rule carries its instruction in the description and governs every request. A context holds substance the model recalls on demand."
      )
      .addDropdown((dropdown) => {
        for (const option of MEMORY_TYPE_OPTIONS) dropdown.addOption(option.value, option.label);
        dropdown.setValue(this.type);
        dropdown.onChange((value) => (this.type = value as MemoryType));
      });

    new SettingItem(contentEl)
      .setName("Description")
      .setDesc(
        `One line, up to ${MEMORY_DESCRIPTION_MAX_CODE_POINTS} characters. It is always in context, so a rule states its constraint here and a context says what it holds and when to recall it.`
      )
      .addText((text) =>
        text
          .setPlaceholder("Never use em dashes; use commas for asides and colons before lists.")
          .setValue(this.description)
          .onChange((value) => (this.description = value))
      );

    new SettingItem(contentEl)
      .setName("Content")
      .setDesc(
        `Optional body, up to ${MEMORY_CONTENT_MAX_CODE_POINTS} characters, returned by recall. A rule often needs none.`
      )
      .addTextArea((text) => {
        text
          .setPlaceholder("The vault's grimdark tone, its narrators, and the register they share.")
          .setValue(this.content)
          .onChange((value) => (this.content = value));
        text.inputEl.rows = 8;
        text.inputEl.addClass("lmsa-input-full");
      });

    new SettingItem(contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText("Save")
          .setCta()
          .onClick(() => this.submit())
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private submit(): void {
    const body = this.content.trim();
    const result = validateMemoryForm(
      {
        name: this.name.trim(),
        type: this.type,
        description: this.description,
        ...(body.length > 0 ? { content: this.content } : {}),
      },
      this.existing,
      this.editingName
    );

    if (!result.ok) {
      new Notice(memoryValidationMessage(result.issue));
      return;
    }

    this.onSave({ ...result.value, enabled: this.enabled });
    this.close();
  }
}

import type WritingAssistantChat from "../main";
import { CommandModal } from "./modals";
import { createSettingsSection } from "./ui";

export function renderCommandsTab(
  container: HTMLElement,
  plugin: WritingAssistantChat,
  refresh: () => void
): void {
  const { settings } = plugin;

  const library = createSettingsSection(
    container,
    "Command Library",
    "Prompt shortcuts that appear in chat and can automatically pull from your current selection or note.",
    { icon: "terminal" }
  );

  const note = library.bodyEl.createDiv({ cls: "lmsa-settings-note" });
  note.createEl("div", {
    cls: "lmsa-settings-note-title",
    text: "Prompt variables",
  });
  const hintList = note.createEl("ul", { cls: "lmsa-hint-list" });
  hintList.createEl("li", {
    text: "{{selection}} inserts the current editor selection.",
  });
  hintList.createEl("li", {
    text: "{{note}} inserts the active note text, trimmed by the advanced context limit.",
  });

  const listEl = library.bodyEl.createDiv({ cls: "lmsa-item-list" });

  const renderList = () => {
    listEl.empty();
    if (settings.commands.length === 0) {
      listEl.createEl("p", {
        cls: "lmsa-empty-state",
        text: "No custom commands configured yet.",
      });
      return;
    }

    for (const command of settings.commands) {
      const row = listEl.createDiv({ cls: "lmsa-item-row" });
      const info = row.createDiv({ cls: "lmsa-item-info" });
      info.createDiv({ cls: "lmsa-item-name", text: command.name });
      info.createDiv({ cls: "lmsa-item-sub", text: command.prompt });

      const actions = row.createDiv({ cls: "lmsa-item-actions" });
      actions
        .createEl("button", {
          cls: "lmsa-btn-secondary lmsa-ui-btn lmsa-ui-btn-secondary",
          text: "Edit",
        })
        .addEventListener("click", () => {
          new CommandModal(plugin.app, command, async (updated) => {
            const index = settings.commands.findIndex((item) => item.id === updated.id);
            if (index >= 0) settings.commands[index] = updated;
            await plugin.saveSettings();
            renderList();
          }).open();
        });

      actions
        .createEl("button", { cls: "lmsa-btn-danger lmsa-ui-btn", text: "Delete" })
        .addEventListener("click", async () => {
          settings.commands = settings.commands.filter((item) => item.id !== command.id);
          await plugin.saveSettings();
          refresh();
        });
    }
  };

  renderList();

  library.footerEl
    .createEl("button", {
      cls: "lmsa-btn-add lmsa-ui-btn lmsa-ui-btn-primary",
      text: "Add command",
    })
    .addEventListener("click", () => {
      new CommandModal(plugin.app, null, async (command) => {
        settings.commands.push(command);
        await plugin.saveSettings();
        refresh();
      }).open();
    });
}

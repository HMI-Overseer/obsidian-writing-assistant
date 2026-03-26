import type LMStudioWritingAssistant from "../main";
import { CommandModal } from "./modals";

export function renderCommandsTab(
  container: HTMLElement,
  plugin: LMStudioWritingAssistant,
  refresh: () => void
): void {
  const { settings } = plugin;

  container.createEl("p", {
    cls: "lmsa-tab-desc",
    text: "Create reusable prompts that appear as quick commands in the chat view. Commands can pull from the current selection or note automatically.",
  });

  const hintList = container.createEl("ul", { cls: "lmsa-hint-list" });
  hintList.createEl("li", {
    text: "{{selection}} inserts the current editor selection.",
  });
  hintList.createEl("li", {
    text: "{{note}} inserts the active note text, trimmed by the advanced context limit.",
  });

  const listEl = container.createDiv({ cls: "lmsa-item-list" });

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
      info.createDiv({
        cls: "lmsa-item-meta",
        text: command.autoInsert
          ? "Auto-inserts into the active note after completion"
          : "Leaves the response in chat until you insert it manually",
      });

      const actions = row.createDiv({ cls: "lmsa-item-actions" });
      actions
        .createEl("button", { cls: "lmsa-btn-secondary", text: "Edit" })
        .addEventListener("click", () => {
          new CommandModal(plugin.app, command, async (updated) => {
            const index = settings.commands.findIndex((item) => item.id === updated.id);
            if (index >= 0) settings.commands[index] = updated;
            await plugin.saveSettings();
            renderList();
          }).open();
        });

      actions
        .createEl("button", { cls: "lmsa-btn-danger", text: "Delete" })
        .addEventListener("click", async () => {
          settings.commands = settings.commands.filter((item) => item.id !== command.id);
          await plugin.saveSettings();
          refresh();
        });
    }
  };

  renderList();

  container
    .createEl("button", { cls: "lmsa-btn-add", text: "+ Add command" })
    .addEventListener("click", () => {
      new CommandModal(plugin.app, null, async (command) => {
        settings.commands.push(command);
        await plugin.saveSettings();
        refresh();
      }).open();
    });
}

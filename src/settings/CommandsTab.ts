import { setIcon } from "obsidian";
import type WritingAssistantChat from "../main";
import type { CustomCommand } from "../shared/types";
import { BUILTIN_COMMAND_CATEGORIES } from "../commands";
import { CommandModal } from "./modals";
import type { SettingsSection } from "./definitions/sections";
import { blockRow } from "./definitions/sections";
import { voidAsync } from "../asyncCallbacks";

/**
 * The one handle this page needs across its rows: the add button sits in the card's footer row and
 * the list it adds to is drawn by another. Set by the row that owns the list and nulled by that
 * row's cleanup, so it is never a closure over DOM Obsidian has torn down.
 */
interface CommandsPageRefs {
  renderCustomList: (() => void) | null;
}

export function commandsTabSections(plugin: WritingAssistantChat): SettingsSection[] {
  const refs: CommandsPageRefs = { renderCustomList: null };

  return [
    {
      name: "Command library",
      desc: "Prompt shortcuts that appear in chat and the editor context menu. Select text, right-click, and pick a command from the Writing assistant submenu.",
      icon: "terminal",
      rows: [
        blockRow("Prompt variables", "", "lmsa-settings-section-block", (el) => {
          const note = el.createDiv({ cls: "lmsa-settings-note" });
          note.createDiv({
            cls: "lmsa-settings-note-title",
            text: "Prompt variables",
          });
          const hintList = note.createEl("ul", { cls: "lmsa-hint-list" });
          hintList.createEl("li", {
            text: "{{selection}} inserts the current editor selection.",
          });
          hintList.createEl("li", {
            text: "{{note}} inserts the active note text, trimmed to the note context limit (keeps the ending when trimmed).",
          });
        }),

        blockRow("Built-in commands", "", "lmsa-settings-section-block", (el) => {
          const builtinListEl = el.createDiv({ cls: "lmsa-item-list" });

          for (const category of BUILTIN_COMMAND_CATEGORIES) {
            builtinListEl.createDiv({
              cls: "lmsa-command-category-label",
              text: category.label,
            });

            for (const command of category.commands) {
              const row = builtinListEl.createDiv({ cls: "lmsa-item-row is-builtin" });

              const iconEl = row.createDiv({ cls: "lmsa-command-icon" });
              setIcon(iconEl, command.icon ?? "wand");

              const info = row.createDiv({ cls: "lmsa-item-info" });
              const header = info.createDiv({ cls: "lmsa-command-header" });
              header.createDiv({
                cls: "lmsa-command-badge is-builtin",
                text: "Built-in",
              });
              header.createDiv({ cls: "lmsa-item-name", text: command.name });
              info.createDiv({ cls: "lmsa-item-sub", text: command.prompt });
            }
          }
        }),

        blockRow("Custom commands", "", "lmsa-settings-section-block", (el) => {
          const customListEl = el.createDiv({ cls: "lmsa-item-list" });

          const renderList = () => {
            const { settings } = plugin;
            customListEl.empty();
            customListEl.createDiv({
              cls: "lmsa-command-category-label",
              text: "Custom commands",
            });

            if (settings.commands.length === 0) {
              customListEl.createEl("p", {
                cls: "lmsa-empty-state",
                text: "No custom commands configured yet.",
              });
              return;
            }

            for (const command of settings.commands) {
              const row = customListEl.createDiv({ cls: "lmsa-item-row" });

              if (command.icon) {
                const iconEl = row.createDiv({ cls: "lmsa-command-icon" });
                setIcon(iconEl, command.icon);
              }

              const info = row.createDiv({ cls: "lmsa-item-info" });
              const header = info.createDiv({ cls: "lmsa-command-header" });
              header.createDiv({
                cls: "lmsa-command-badge is-user-created",
                text: "User-created",
              });
              header.createDiv({ cls: "lmsa-item-name", text: command.name });
              info.createDiv({ cls: "lmsa-item-sub", text: command.prompt });

              const actions = row.createDiv({ cls: "lmsa-item-actions" });
              actions
                .createEl("button", {
                  cls: "lmsa-btn-secondary lmsa-ui-btn lmsa-ui-btn-secondary",
                  text: "Edit",
                })
                .addEventListener("click", () => {
                  new CommandModal(plugin.app, command, voidAsync(async (updated: CustomCommand) => {
                    const index = plugin.settings.commands.findIndex(
                      (item) => item.id === updated.id
                    );
                    if (index >= 0) plugin.settings.commands[index] = updated;
                    await plugin.saveSettings();
                    renderList();
                  }, "Failed to save the command.")).open();
                });

              actions
                .createEl("button", { cls: "lmsa-btn-danger lmsa-ui-btn", text: "Delete" })
                .addEventListener("click", voidAsync(async () => {
                  plugin.settings.commands = plugin.settings.commands.filter(
                    (item) => item.id !== command.id
                  );
                  await plugin.saveSettings();
                  renderList();
                }, "Failed to delete the command."));
            }
          };

          renderList();
          refs.renderCustomList = renderList;
          return () => {
            refs.renderCustomList = null;
          };
        }),

        blockRow("Add command", "", "lmsa-settings-section-footer", (el) => {
          el.createEl("button", {
            cls: "lmsa-btn-add lmsa-ui-btn lmsa-ui-btn-primary",
            text: "Add command",
          }).addEventListener("click", () => {
            new CommandModal(plugin.app, null, voidAsync(async (command: CustomCommand) => {
              plugin.settings.commands.push(command);
              await plugin.saveSettings();
              refs.renderCustomList?.();
            }, "Failed to add the command.")).open();
          });
        }),
      ],
    },
  ];
}

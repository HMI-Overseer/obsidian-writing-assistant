import type { MenuItem, WorkspaceLeaf } from "obsidian";
import { Notice, Plugin } from "obsidian";
import type { CustomCommand, PluginSettings } from "./shared/types";
import { VIEW_TYPE_CHAT } from "./constants";
import { ChatView } from "./chat";
import { BUILTIN_COMMAND_CATEGORIES, expandCommandTemplate } from "./commands";
import { getActiveNoteText } from "./context/noteContext";
import { InlineDiffManager } from "./editing/inlineDiff/InlineDiffManager";
import { inlineDiffExtension } from "./editing/inlineDiff/inlineDiffState";
import { normalizePluginSettings } from "./settings/settingsMigration";
import { WritingAssistantSettingTab } from "./settings/SettingsTab";
import { ServiceContainer } from "./services/ServiceContainer";

export default class WritingAssistantChat extends Plugin {
  settings!: PluginSettings;
  services!: ServiceContainer;
  inlineDiff!: InlineDiffManager;

  async onload(): Promise<void> {
    await this.loadSettings();
    const pluginDir =
      this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    this.services = new ServiceContainer(this.app, () => this.settings, pluginDir);
    await this.services.initialize();

    // In-note diff overlay: a CM6 extension renders pending edit proposals inline
    // in the active editor, sharing the same EditReviewController as the chat panel.
    this.inlineDiff = new InlineDiffManager(this.app);
    this.registerEditorExtension(inlineDiffExtension);
    for (const ref of this.inlineDiff.workspaceEvents()) this.registerEvent(ref);

    this.registerView(VIEW_TYPE_CHAT, (leaf: WorkspaceLeaf) => new ChatView(leaf, this));

    this.addRibbonIcon("message-square", "Writing assistant chat", () => {
      this.activateChatView();
    });

    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      callback: () => this.activateChatView(),
    });

    this.addCommand({
      id: "send-selection-to-chat",
      name: "Send selection to chat",
      editorCallback: (editor) => {
        const selection = editor.getSelection();
        if (!selection) {
          new Notice("No text selected.");
          return;
        }

        this.activateChatView().then(() => {
          setTimeout(() => {
            const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
            if (leaves.length > 0) {
              const view = leaves[0].view as ChatView;
              view.seedPrompt(selection);
            }
          }, 100);
        });
      },
    });

    this.addCommand({
      id: "edit-active-note",
      name: "Edit active note with AI",
      editorCallback: async () => {
        await this.activateChatView();
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
        if (leaves.length > 0) {
          const view = leaves[0].view as ChatView;
          view.setMode("edit");
        }
      },
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        const selection = editor.getSelection();
        if (!selection) return;

        menu.addItem((item) => {
          item.setTitle("Writing assistant").setIcon("message-square");
          const submenu = (item as MenuItem & { setSubmenu: () => typeof menu }).setSubmenu();

          const addCommandItem = (command: CustomCommand) => {
            submenu.addItem((sub) => {
              sub.setTitle(command.name).setIcon(command.icon ?? "wand").onClick(async () => {
                // Keep the note's tail: {{note}} feeds continuation commands
                // ("Continue writing from where the note leaves off"), so when a
                // long chapter exceeds the budget the model must see the ending,
                // not the opening.
                const noteText =
                  (await getActiveNoteText(this.app, this.settings.maxContextChars, "tail")) ?? "";
                const expanded = expandCommandTemplate(command.prompt, { selection, noteText });

                await this.activateChatView();
                setTimeout(async () => {
                  const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
                  if (leaves.length > 0) {
                    await (leaves[0].view as ChatView).sendCommand(expanded);
                  }
                }, 100);
              });
            });
          };

          for (let i = 0; i < BUILTIN_COMMAND_CATEGORIES.length; i++) {
            if (i > 0) submenu.addSeparator();
            for (const command of BUILTIN_COMMAND_CATEGORIES[i].commands) {
              addCommandItem(command);
            }
          }

          const userCommands = this.settings.commands;
          if (userCommands.length > 0) {
            submenu.addSeparator();
            for (const command of userCommands) {
              addCommandItem(command);
            }
          }
        });
      })
    );

    this.addSettingTab(new WritingAssistantSettingTab(this.app, this));

    if (this.app.workspace.layoutReady) {
      this.initLeafIfNeeded();
    } else {
      this.app.workspace.onLayoutReady(() => this.initLeafIfNeeded());
    }
  }

  onunload(): void {
    this.inlineDiff.destroy();
    this.services.destroy();
    // Obsidian handles view cleanup automatically on plugin unload.
    // Detaching leaves here would reset their position on reload.
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<PluginSettings> | null;
    this.settings = normalizePluginSettings(data);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private initLeafIfNeeded(): void {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
    if (existing.length === 0) return;
    this.app.workspace.revealLeaf(existing[0]);
  }

  async activateChatView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
}

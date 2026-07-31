import type { MenuItem, WorkspaceLeaf } from "obsidian";
import { Notice, Plugin } from "obsidian";
import type { CustomCommand, PluginSettings } from "./shared/types";
import { VIEW_TYPE_CHAT } from "./constants";
import { ChatView } from "./chat";
import { BUILTIN_COMMAND_CATEGORIES, expandCommandTemplate } from "./commands";
import { getActiveNoteText } from "./context/noteContext";
import { InlineDiffManager } from "./editing/inlineDiff/InlineDiffManager";
import { inlineDiffExtension } from "./editing/inlineDiff/inlineDiffState";
import { registerBrandIcons, unregisterBrandIcons } from "./providers/brandIcons";
import { normalizePluginSettings } from "./settings/settingsMigration";
import { WritingAssistantSettingTab } from "./settings/SettingsTab";
import { ServiceContainer } from "./services/ServiceContainer";
import { reportIfRejected } from "./asyncCallbacks";
import { installDriverBridge } from "./dev/driverBridge";

export default class WritingAssistantChat extends Plugin {
  settings!: PluginSettings;
  services!: ServiceContainer;
  inlineDiff!: InlineDiffManager;

  async onload(): Promise<void> {
    registerBrandIcons();
    await this.loadSettings();
    const pluginDir =
      this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    this.services = new ServiceContainer(
      this.app,
      () => this.settings,
      pluginDir,
      () => this.saveSettings(),
    );
    await this.services.initialize();

    // In-note diff overlay: a CM6 extension renders pending edit proposals inline
    // in the active editor, sharing the same EditReviewController as the chat panel.
    this.inlineDiff = new InlineDiffManager(this.app);
    this.registerEditorExtension(inlineDiffExtension);
    for (const ref of this.inlineDiff.workspaceEvents()) this.registerEvent(ref);

    this.registerView(VIEW_TYPE_CHAT, (leaf: WorkspaceLeaf) => new ChatView(leaf, this));

    this.addRibbonIcon("message-square", "Writing assistant chat", () => {
      // Fire-and-forget: a ribbon click should not block, and Obsidian ignores the
      // callback's return, so an unhandled rejection is surfaced here as a Notice.
      // There is no chat timeline in scope yet (we are opening the view), so Notice
      // is the user-facing surface, not decorateError.
      reportIfRejected(this.activateChatView(), "Failed to open the writing assistant chat.");
    });

    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      callback: () =>
        reportIfRejected(this.activateChatView(), "Failed to open the writing assistant chat."),
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

        // Fire-and-forget from a void editorCallback: open the view, then seed the
        // prompt once it exists. Any failure surfaces as a Notice; the timeline that
        // would carry a decorateError does not exist until the view is open.
        reportIfRejected(
          this.activateChatView().then(() => {
            window.setTimeout(() => {
              const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
              if (leaves.length > 0) {
                const view = leaves[0].view as ChatView;
                view.seedPrompt(selection);
              }
            }, 100);
          }),
          "Failed to open the writing assistant chat.",
        );
      },
    });

    this.addCommand({
      id: "edit-active-note",
      name: "Edit active note with AI",
      // Editing is now ambient: the chat can always
      // propose edits to the active note (reviewed at the default "ask" posture),
      // so the command just opens the chat with the note in context.
      editorCallback: async () => {
        await this.activateChatView();
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
                window.setTimeout(() => {
                  const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
                  if (leaves.length > 0) {
                    reportIfRejected(
                      (leaves[0].view as ChatView).sendCommand(expanded),
                      "Failed to run the command.",
                    );
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

    // The live scenario driver's setup-and-readout seam (RFC-0013), compiled out of a release.
    if (DEV_DRIVER) {
      installDriverBridge(this);
    }
  }

  onunload(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)) {
      if (leaf.view instanceof ChatView) {
        leaf.view.prepareForPluginUnload();
      }
    }
    unregisterBrandIcons();
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
    // Startup reveal of a restored leaf, fire-and-forget: this method is a sync void
    // callback for onLayoutReady, so a failed reveal surfaces as a Notice.
    reportIfRejected(
      this.app.workspace.revealLeaf(existing[0]),
      "Failed to reveal the writing assistant chat.",
    );
  }

  async activateChatView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
    if (existing.length > 0) {
      // Awaited: revealing the view is the whole job of this method, and callers await
      // it (or route it through reportIfRejected), so a failed reveal propagates rather
      // than floating.
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }
}

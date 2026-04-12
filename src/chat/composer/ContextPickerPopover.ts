import { FuzzySuggestModal, setIcon } from "obsidian";
import type { App, TFile } from "obsidian";
import type { ChatLayoutRefs } from "../types";

export type ContextPickerPopoverCallbacks = {
  isActiveNoteAttached: () => boolean;
  getActiveFileName: () => string | null;
  onAddActiveNote: () => void;
  onAddVaultNote: (filePath: string, fileName: string) => void;
  onBeforeOpen?: () => void;
};

export class ContextPickerPopover {
  private popoverOpen = false;
  private readonly onBtnClick: (event: MouseEvent) => void;
  private readonly onPopoverClick: (event: MouseEvent) => void;

  constructor(
    private readonly app: App,
    private readonly refs: Pick<ChatLayoutRefs, "contextAddBtnEl" | "contextPickerPopoverEl">,
    private readonly callbacks: ContextPickerPopoverCallbacks
  ) {
    this.onBtnClick = (event: MouseEvent) => {
      event.stopPropagation();
      if (this.popoverOpen) {
        this.close();
      } else {
        this.open();
      }
    };

    this.onPopoverClick = (event: MouseEvent) => {
      event.stopPropagation();
    };

    this.refs.contextAddBtnEl.addEventListener("click", this.onBtnClick);
    this.refs.contextPickerPopoverEl.addEventListener("click", this.onPopoverClick);
  }

  open(): void {
    this.callbacks.onBeforeOpen?.();
    this.popoverOpen = true;
    this.refs.contextAddBtnEl.addClass("is-open");
    this.refs.contextPickerPopoverEl.removeClass("lmsa-hidden");
    this.renderContent();
  }

  close(): void {
    this.popoverOpen = false;
    this.refs.contextAddBtnEl.removeClass("is-open");
    this.refs.contextPickerPopoverEl.addClass("lmsa-hidden");
    this.refs.contextPickerPopoverEl.empty();
  }

  isOpen(): boolean {
    return this.popoverOpen;
  }

  destroy(): void {
    this.close();
    this.refs.contextAddBtnEl.removeEventListener("click", this.onBtnClick);
    this.refs.contextPickerPopoverEl.removeEventListener("click", this.onPopoverClick);
  }

  private renderContent(): void {
    const el = this.refs.contextPickerPopoverEl;
    el.empty();

    const activeFileName = this.callbacks.getActiveFileName();
    const isAttached = this.callbacks.isActiveNoteAttached() && !!activeFileName;
    // Disabled when already attached OR when there is no active file to attach
    const noteDisabled = isAttached || !activeFileName;

    // ── "Add current note" row ───────────────────────────────────────────────
    const noteRow = el.createDiv({
      cls: ["lmsa-context-picker-row", noteDisabled ? "is-disabled" : ""].filter(Boolean).join(" "),
    });

    const noteIcon = noteRow.createEl("span", { cls: "lmsa-context-picker-row-icon" });
    setIcon(noteIcon, "file-text");

    const noteLabel = noteRow.createEl("span", { cls: "lmsa-context-picker-row-label" });
    noteLabel.createEl("span", { cls: "lmsa-context-picker-row-title", text: "Add current note" });
    noteLabel.createEl("span", {
      cls: "lmsa-context-picker-row-hint",
      text: activeFileName ?? "No note open",
    });

    if (isAttached) {
      const checkIcon = noteRow.createEl("span", { cls: "lmsa-context-picker-row-check" });
      setIcon(checkIcon, "check");
    }

    if (!noteDisabled) {
      noteRow.addEventListener("click", () => {
        this.close();
        this.callbacks.onAddActiveNote();
      });
    }

    // ── "Add note from vault" row ────────────────────────────────────────────
    const vaultRow = el.createDiv({ cls: "lmsa-context-picker-row" });

    const vaultIcon = vaultRow.createEl("span", { cls: "lmsa-context-picker-row-icon" });
    setIcon(vaultIcon, "search");

    const vaultLabel = vaultRow.createEl("span", { cls: "lmsa-context-picker-row-label" });
    vaultLabel.createEl("span", { cls: "lmsa-context-picker-row-title", text: "Add note from vault" });

    vaultRow.addEventListener("click", () => {
      this.close();
      new VaultNotePicker(this.app, (file) => {
        this.callbacks.onAddVaultNote(file.path, file.name);
      }).open();
    });
  }
}

class VaultNotePicker extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private readonly onPick: (file: TFile) => void
  ) {
    super(app);
    this.setPlaceholder("Search vault notes...");
  }

  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles();
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.onPick(file);
  }
}

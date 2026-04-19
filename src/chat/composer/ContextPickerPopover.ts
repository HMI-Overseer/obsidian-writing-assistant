import { setIcon } from "obsidian";
import type { App, TFile } from "obsidian";
import type { ChatLayoutRefs } from "../types";

export type ContextPickerPopoverCallbacks = {
  isActiveNoteAttached: () => boolean;
  getActiveFileName: () => string | null;
  onAddActiveNote: () => void;
  onAddVaultNote: (filePath: string, fileName: string) => void;
  canAttachImages: () => boolean;
  onAttachImage: () => void;
  onBeforeOpen?: () => void;
};

const MAX_RESULTS = 12;
const SEARCH_DEBOUNCE_MS = 100;

export class ContextPickerPopover {
  private popoverOpen = false;
  private searchMode = false;
  private searchDebounce: ReturnType<typeof setTimeout> | null = null;
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
    this.searchMode = false;
    this.popoverOpen = true;
    this.refs.contextAddBtnEl.addClass("is-open");
    this.refs.contextPickerPopoverEl.removeClass("lmsa-hidden");
    this.refs.contextPickerPopoverEl.removeClass("is-search");
    this.renderContent();
  }

  close(): void {
    if (this.searchDebounce !== null) {
      clearTimeout(this.searchDebounce);
      this.searchDebounce = null;
    }
    this.searchMode = false;
    this.popoverOpen = false;
    this.refs.contextAddBtnEl.removeClass("is-open");
    this.refs.contextPickerPopoverEl.addClass("lmsa-hidden");
    this.refs.contextPickerPopoverEl.removeClass("is-search");
    this.refs.contextPickerPopoverEl.empty();
  }

  isOpen(): boolean {
    return this.popoverOpen;
  }

  destroy(): void {
    if (this.searchDebounce !== null) {
      clearTimeout(this.searchDebounce);
    }
    this.close();
    this.refs.contextAddBtnEl.removeEventListener("click", this.onBtnClick);
    this.refs.contextPickerPopoverEl.removeEventListener("click", this.onPopoverClick);
  }

  private renderContent(): void {
    const el = this.refs.contextPickerPopoverEl;
    el.empty();

    if (this.searchMode) {
      this.renderSearchView(el);
    } else {
      this.renderMenuView(el);
    }
  }

  private renderMenuView(el: HTMLElement): void {
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
      this.enterSearchMode();
    });

    // ── "Attach image" row (only when the active model supports vision) ──────
    if (this.callbacks.canAttachImages()) {
      const imageRow = el.createDiv({ cls: "lmsa-context-picker-row" });

      const imageIcon = imageRow.createEl("span", { cls: "lmsa-context-picker-row-icon" });
      setIcon(imageIcon, "image");

      const imageLabel = imageRow.createEl("span", { cls: "lmsa-context-picker-row-label" });
      imageLabel.createEl("span", { cls: "lmsa-context-picker-row-title", text: "Attach image" });

      imageRow.addEventListener("click", () => {
        this.close();
        this.callbacks.onAttachImage();
      });
    }
  }

  private enterSearchMode(): void {
    this.searchMode = true;
    this.refs.contextPickerPopoverEl.addClass("is-search");
    this.renderContent();
  }

  private renderSearchView(el: HTMLElement): void {
    // ── Search input row ─────────────────────────────────────────────────────
    const searchWrap = el.createDiv({ cls: "lmsa-context-picker-search-wrap" });

    const searchIconEl = searchWrap.createEl("span", { cls: "lmsa-context-picker-search-icon" });
    setIcon(searchIconEl, "search");

    const input = searchWrap.createEl("input", {
      cls: "lmsa-context-picker-search-input",
      attr: { type: "text", placeholder: "Search notes…" },
    });

    // ── Results list ─────────────────────────────────────────────────────────
    const resultsEl = el.createDiv({ cls: "lmsa-context-picker-results" });

    // Show recent files immediately before the user starts typing
    this.renderResults("", resultsEl);

    // Focus after the element lands in the DOM
    setTimeout(() => input.focus(), 0);

    // Escape → close the popover entirely
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.close();
      }
    });

    // Live search with debounce
    input.addEventListener("input", () => {
      if (this.searchDebounce !== null) clearTimeout(this.searchDebounce);
      this.searchDebounce = setTimeout(() => {
        resultsEl.empty();
        this.renderResults(input.value, resultsEl);
        this.searchDebounce = null;
      }, SEARCH_DEBOUNCE_MS);
    });
  }

  private renderResults(query: string, container: HTMLElement): void {
    const allFiles = this.app.vault.getMarkdownFiles();

    const files = query.trim()
      ? filterFiles(query.trim(), allFiles)
      : allFiles.sort((a, b) => b.stat.mtime - a.stat.mtime).slice(0, MAX_RESULTS);

    if (files.length === 0) {
      container.createDiv({ cls: "lmsa-context-picker-results-empty", text: "No notes found" });
      return;
    }

    for (const file of files) {
      const item = container.createDiv({ cls: "lmsa-context-picker-result-item" });

      item.createEl("span", { cls: "lmsa-context-picker-result-name", text: file.basename });

      if (file.parent && file.parent.path !== "/") {
        item.createEl("span", { cls: "lmsa-context-picker-result-path", text: file.parent.path });
      }

      item.addEventListener("click", () => {
        this.close();
        this.callbacks.onAddVaultNote(file.path, file.name);
      });
    }
  }
}

// ── Fuzzy helpers ────────────────────────────────────────────────────────────

function filterFiles(query: string, files: TFile[]): TFile[] {
  const q = query.toLowerCase();
  const scored: Array<{ file: TFile; score: number }> = [];

  for (const file of files) {
    const score = fuzzyScore(q, file);
    if (score > 0) scored.push({ file, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_RESULTS).map((s) => s.file);
}

function fuzzyScore(query: string, file: TFile): number {
  const name = file.basename.toLowerCase();
  const path = file.path.toLowerCase();

  if (name === query) return 100;
  if (name.startsWith(query)) return 80;
  if (name.includes(query)) return 60;
  if (path.includes(query)) return 40;

  // Subsequence check against the full path
  let i = 0;
  for (let j = 0; j < path.length && i < query.length; j++) {
    if (path[j] === query[i]) i++;
  }
  return i === query.length ? 20 : 0;
}

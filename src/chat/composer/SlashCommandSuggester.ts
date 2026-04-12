import type { CustomCommand } from "../../shared/types";

type SlashCommandCallbacks = {
  getCommands: () => CustomCommand[];
  onSelect: (command: CustomCommand, triggerStart: number, triggerEnd: number) => void;
};

export class SlashCommandSuggester {
  private open = false;
  private activeIndex = 0;
  private items: CustomCommand[] = [];
  private triggerStart = 0;
  private itemEls: HTMLElement[] = [];

  private readonly onKeydown: (event: KeyboardEvent) => void;
  private readonly onContainerClick: (event: MouseEvent) => void;

  constructor(
    private readonly textareaEl: HTMLTextAreaElement,
    private readonly dropdownEl: HTMLElement,
    private readonly callbacks: SlashCommandCallbacks,
  ) {
    this.onKeydown = (event: KeyboardEvent) => this.handleKeydown(event);
    this.onContainerClick = (event: MouseEvent) => event.stopPropagation();

    this.textareaEl.addEventListener("keydown", this.onKeydown);
    this.dropdownEl.addEventListener("click", this.onContainerClick);
  }

  /** Call on every textarea `input` event. */
  handleInput(): void {
    const cursorPos = this.textareaEl.selectionStart;
    const text = this.textareaEl.value;

    const trigger = this.findTrigger(text, cursorPos);
    if (!trigger) {
      this.close();
      return;
    }

    const commands = this.callbacks.getCommands();
    if (commands.length === 0) {
      this.close();
      return;
    }

    const query = trigger.query.toLowerCase();
    const filtered = query
      ? commands.filter((cmd) => cmd.name.toLowerCase().startsWith(query))
      : commands;

    if (filtered.length === 0) {
      this.close();
      return;
    }

    this.triggerStart = trigger.start;
    this.items = filtered;
    this.activeIndex = 0;
    this.show();
    this.renderItems();
  }

  isOpen(): boolean {
    return this.open;
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.dropdownEl.addClass("lmsa-hidden");
    this.items = [];
    this.itemEls = [];
    this.activeIndex = 0;
  }

  destroy(): void {
    this.textareaEl.removeEventListener("keydown", this.onKeydown);
    this.dropdownEl.removeEventListener("click", this.onContainerClick);
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private show(): void {
    this.open = true;
    this.dropdownEl.removeClass("lmsa-hidden");
  }

  private findTrigger(
    text: string,
    cursorPos: number,
  ): { start: number; query: string } | null {
    if (cursorPos === 0) return null;

    // Scan backward from cursor to find a `/` that starts the current word.
    let pos = cursorPos - 1;
    while (pos >= 0 && text[pos] !== "/" && text[pos] !== " " && text[pos] !== "\n") {
      pos--;
    }

    if (pos < 0 || text[pos] !== "/") return null;

    // Guard: `/` must be at start of text or preceded by whitespace.
    if (pos > 0 && !/\s/.test(text[pos - 1])) return null;

    return {
      start: pos,
      query: text.slice(pos + 1, cursorPos),
    };
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (!this.open) return;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        this.activeIndex = (this.activeIndex + 1) % this.items.length;
        this.syncActiveItem();
        break;

      case "ArrowUp":
        event.preventDefault();
        this.activeIndex = (this.activeIndex - 1 + this.items.length) % this.items.length;
        this.syncActiveItem();
        break;

      case "Enter":
      case "Tab":
        event.preventDefault();
        event.stopPropagation();
        this.confirmSelection();
        break;

      case "Escape":
        event.preventDefault();
        this.close();
        break;
    }
  }

  private confirmSelection(): void {
    const command = this.items[this.activeIndex];
    if (!command) return;

    const triggerEnd = this.textareaEl.selectionStart;
    this.close();
    this.callbacks.onSelect(command, this.triggerStart, triggerEnd);
  }

  private renderItems(): void {
    this.dropdownEl.empty();
    this.itemEls = [];

    const list = this.dropdownEl.createDiv({ cls: "lmsa-slash-dropdown-list" });

    for (let i = 0; i < this.items.length; i++) {
      const command = this.items[i];
      const item = list.createDiv({ cls: "lmsa-slash-dropdown-item" });

      item.createDiv({ cls: "lmsa-slash-dropdown-name", text: `/${command.name}` });
      item.createDiv({
        cls: "lmsa-slash-dropdown-desc",
        text: command.prompt.length > 60
          ? command.prompt.slice(0, 57) + "..."
          : command.prompt,
      });

      if (i === this.activeIndex) {
        item.addClass("is-active");
      }

      item.addEventListener("mouseenter", () => {
        this.activeIndex = i;
        this.syncActiveItem();
      });

      item.addEventListener("click", (event) => {
        event.stopPropagation();
        this.activeIndex = i;
        this.confirmSelection();
      });

      this.itemEls.push(item);
    }
  }

  private syncActiveItem(): void {
    for (let i = 0; i < this.itemEls.length; i++) {
      this.itemEls[i].toggleClass("is-active", i === this.activeIndex);
    }
    this.itemEls[this.activeIndex]?.scrollIntoView({ block: "nearest" });
  }
}

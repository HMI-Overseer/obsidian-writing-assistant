import { setIcon } from "obsidian";

/* ════════════════════════════════════════════════════════════════════════════
 *  Sub-components — lightweight wrappers around native HTML elements
 *  that mirror the Obsidian Setting sub-component API surface we use.
 * ════════════════════════════════════════════════════════════════════════ */

export class TextInput {
  inputEl: HTMLInputElement;
  private changeCb?: (value: string) => unknown;

  constructor(containerEl: HTMLElement) {
    this.inputEl = containerEl.createEl("input", { type: "text" });
    this.inputEl.addEventListener("input", () => {
      this.changeCb?.(this.inputEl.value);
    });
  }

  setPlaceholder(placeholder: string): this {
    this.inputEl.placeholder = placeholder;
    return this;
  }

  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }

  onChange(cb: (value: string) => unknown): this {
    this.changeCb = cb;
    return this;
  }
}

export class TextAreaInput {
  inputEl: HTMLTextAreaElement;
  private changeCb?: (value: string) => unknown;

  constructor(containerEl: HTMLElement) {
    this.inputEl = containerEl.createEl("textarea");
    this.inputEl.addEventListener("input", () => {
      this.changeCb?.(this.inputEl.value);
    });
  }

  setPlaceholder(placeholder: string): this {
    this.inputEl.placeholder = placeholder;
    return this;
  }

  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }

  onChange(cb: (value: string) => unknown): this {
    this.changeCb = cb;
    return this;
  }
}

export class Toggle {
  toggleEl: HTMLDivElement;
  private value = false;
  private changeCb?: (value: boolean) => unknown;

  constructor(containerEl: HTMLElement) {
    this.toggleEl = containerEl.createDiv({ cls: "lmsa-toggle" });
    this.toggleEl.setAttribute("role", "switch");
    this.toggleEl.setAttribute("aria-checked", "false");
    this.toggleEl.tabIndex = 0;

    this.toggleEl.addEventListener("click", () => this.toggle());
    this.toggleEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.toggle();
      }
    });
  }

  private toggle(): void {
    this.setValue(!this.value);
    this.changeCb?.(this.value);
  }

  setValue(on: boolean): this {
    this.value = on;
    this.toggleEl.classList.toggle("is-enabled", on);
    this.toggleEl.setAttribute("aria-checked", String(on));
    return this;
  }

  onChange(cb: (value: boolean) => unknown): this {
    this.changeCb = cb;
    return this;
  }
}

export class Button {
  buttonEl: HTMLButtonElement;

  constructor(containerEl: HTMLElement) {
    this.buttonEl = containerEl.createEl("button", { cls: "lmsa-ui-btn lmsa-ui-btn-secondary" });
  }

  setButtonText(name: string): this {
    this.buttonEl.textContent = name;
    return this;
  }

  setCta(): this {
    this.buttonEl.classList.remove("lmsa-ui-btn-secondary");
    this.buttonEl.classList.add("lmsa-ui-btn-primary");
    return this;
  }

  onClick(cb: (evt: MouseEvent) => unknown | Promise<unknown>): this {
    this.buttonEl.addEventListener("click", cb);
    return this;
  }
}

export class Dropdown {
  selectEl: HTMLSelectElement;
  private changeCb?: (value: string) => unknown;

  constructor(containerEl: HTMLElement) {
    this.selectEl = containerEl.createEl("select");
    this.selectEl.addEventListener("change", () => {
      this.changeCb?.(this.selectEl.value);
    });
  }

  addOption(value: string, display: string): this {
    this.selectEl.createEl("option", { value, text: display });
    return this;
  }

  setValue(value: string): this {
    this.selectEl.value = value;
    return this;
  }

  onChange(cb: (value: string) => unknown): this {
    this.changeCb = cb;
    return this;
  }
}

/* ════════════════════════════════════════════════════════════════════════════
 *  SettingItem — drop-in replacement for Obsidian's Setting class that
 *  produces lmsa-prefixed DOM instead of setting-item classes.
 * ════════════════════════════════════════════════════════════════════════ */

export class SettingItem {
  settingEl: HTMLElement;
  infoEl: HTMLElement;
  nameEl: HTMLElement;
  descEl: HTMLElement;
  controlEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    this.settingEl = containerEl.createDiv({ cls: "lmsa-setting-item" });
    this.infoEl = this.settingEl.createDiv({ cls: "lmsa-setting-item-info" });
    this.nameEl = this.infoEl.createDiv({ cls: "lmsa-setting-item-name" });
    this.descEl = this.infoEl.createDiv({ cls: "lmsa-setting-item-desc" });
    this.controlEl = this.settingEl.createDiv({ cls: "lmsa-setting-item-control" });
  }

  setName(name: string): this {
    this.nameEl.textContent = name;
    return this;
  }

  setDesc(desc: string): this {
    this.descEl.textContent = desc;
    return this;
  }

  addText(cb: (text: TextInput) => void): this {
    cb(new TextInput(this.controlEl));
    return this;
  }

  addTextArea(cb: (textarea: TextAreaInput) => void): this {
    cb(new TextAreaInput(this.controlEl));
    return this;
  }

  addToggle(cb: (toggle: Toggle) => void): this {
    cb(new Toggle(this.controlEl));
    return this;
  }

  addButton(cb: (button: Button) => void): this {
    cb(new Button(this.controlEl));
    return this;
  }

  addDropdown(cb: (dropdown: Dropdown) => void): this {
    cb(new Dropdown(this.controlEl));
    return this;
  }
}

/* ════════════════════════════════════════════════════════════════════════════
 *  Settings section helper
 * ════════════════════════════════════════════════════════════════════════ */

export type SettingsSectionRefs = {
  sectionEl: HTMLElement;
  headerEl: HTMLElement;
  headerActionsEl: HTMLElement;
  bodyEl: HTMLElement;
  footerEl: HTMLElement;
};

export interface SectionOptions {
  /** Lucide icon name rendered as a colored badge in the section header. */
  icon?: string;
}

export function createSettingsSection(
  container: HTMLElement,
  title: string,
  description?: string,
  options?: SectionOptions
): SettingsSectionRefs {
  const sectionEl = container.createDiv({ cls: "lmsa-settings-section lmsa-ui-card" });
  const headerEl = sectionEl.createDiv({ cls: "lmsa-settings-section-header" });
  const headingEl = headerEl.createDiv({ cls: "lmsa-settings-section-heading" });
  const headerActionsEl = headerEl.createDiv({ cls: "lmsa-settings-section-actions" });

  if (options?.icon) {
    const badge = headingEl.createDiv({ cls: "lmsa-settings-section-icon" });
    setIcon(badge, options.icon);
  }

  headingEl.createEl("h3", {
    cls: "lmsa-settings-section-title",
    text: title,
  });

  const bodyEl = sectionEl.createDiv({ cls: "lmsa-settings-section-body" });

  if (description) {
    bodyEl.createEl("p", {
      cls: "lmsa-settings-section-desc",
      text: description,
    });
  }
  const footerEl = sectionEl.createDiv({ cls: "lmsa-settings-section-footer" });

  return { sectionEl, headerEl, headerActionsEl, bodyEl, footerEl };
}

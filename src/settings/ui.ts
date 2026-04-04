import { setIcon } from "obsidian";
import type { ModelAvailabilityState, ProviderOption } from "../shared/types";

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
 *  Model selector — custom dropdown with availability status indicators
 * ════════════════════════════════════════════════════════════════════════ */

export interface ModelSelectorItem {
  id: string;
  name: string;
  modelId: string;
  provider: ProviderOption;
}

export interface ModelSelectorDeps {
  getAvailability: (modelId: string, provider: ProviderOption) => ModelAvailabilityState;
  refreshLocalModels: () => Promise<void>;
}

export interface ModelSelectorRefs {
  wrapEl: HTMLElement;
  /** Programmatically update the selected model and refresh the UI. */
  setSelected: (model: ModelSelectorItem | null) => void;
  /** Cleanup function — removes the document click listener. */
  destroy: () => void;
}

/**
 * Creates a custom model selector with a status dot, dropdown list, and
 * per-item availability indicators. Mirrors the Benchmark tab's selector
 * without the profile-settings popover.
 */
export function createModelSelector(
  containerEl: HTMLElement,
  models: ModelSelectorItem[],
  deps: ModelSelectorDeps,
  opts: {
    initial: ModelSelectorItem | null;
    placeholder?: string;
    onSelect: (model: ModelSelectorItem | null) => void;
  },
): ModelSelectorRefs {
  let selected = opts.initial;
  let isOpen = false;

  const wrapEl = containerEl.createDiv({ cls: "lmsa-header-meta-wrap lmsa-settings-model-selector-wrap" });
  const btn = wrapEl.createDiv({ cls: "lmsa-header-meta lmsa-settings-model-selector" });
  const statusEl = btn.createEl("span", { cls: "lmsa-model-selector-status is-unknown" });
  const labelEl = btn.createEl("span", {
    cls: "lmsa-header-meta-label",
    text: selected?.name ?? (opts.placeholder ?? "Select model..."),
  });
  const chevronEl = btn.createEl("span", { cls: "lmsa-header-meta-chevron" });
  setIcon(chevronEl, "chevron-down");

  const dropdownEl = wrapEl.createDiv({ cls: "lmsa-model-dropdown lmsa-hidden" });

  // ── Status helpers ──

  function updateStatus(): void {
    statusEl.removeClass("is-loaded", "is-unloaded", "is-unknown", "is-cloud", "is-hidden");
    if (!selected?.modelId) {
      statusEl.addClass("is-hidden");
      return;
    }
    const state = deps.getAvailability(selected.modelId, selected.provider);
    statusEl.addClass(`is-${state}`);
  }

  async function refreshAvailability(): Promise<void> {
    try { await deps.refreshLocalModels(); } catch { /* handled by service */ }
    updateStatus();
  }

  // ── Open / close ──

  function close(): void {
    dropdownEl.addClass("lmsa-hidden");
    isOpen = false;
    btn.removeClass("is-active");
    chevronEl.empty();
    setIcon(chevronEl, "chevron-down");
  }

  function open(): void {
    dropdownEl.empty();
    dropdownEl.removeClass("lmsa-hidden");
    isOpen = true;
    btn.addClass("is-active");
    chevronEl.empty();
    setIcon(chevronEl, "chevron-up");

    const listEl = dropdownEl.createDiv({ cls: "lmsa-model-dropdown-list" });

    for (const m of models) {
      const item = listEl.createDiv({ cls: "lmsa-model-dropdown-item" });
      const checkSpan = item.createEl("span", { cls: "lmsa-model-dropdown-check" });
      if (selected && m.id === selected.id) {
        item.addClass("is-active");
        setIcon(checkSpan, "check");
      }
      const copy = item.createDiv({ cls: "lmsa-model-dropdown-copy" });
      copy.createEl("span", { cls: "lmsa-model-dropdown-name", text: m.name });
      const itemState = deps.getAvailability(m.modelId, m.provider);
      item.createEl("span", { cls: `lmsa-model-dropdown-state is-${itemState}` });

      item.addEventListener("click", (e) => {
        e.stopPropagation();
        selected = m;
        labelEl.setText(m.name);
        updateStatus();
        close();
        opts.onSelect(m);
      });
    }
  }

  // ── Events ──

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (isOpen) close(); else open();
  });

  const onDocClick = (): void => { if (isOpen) close(); };
  document.addEventListener("click", onDocClick);

  // ── Init ──
  void refreshAvailability();

  return {
    wrapEl,
    setSelected(model) {
      selected = model;
      labelEl.setText(model?.name ?? (opts.placeholder ?? "Select model..."));
      updateStatus();
    },
    destroy() {
      document.removeEventListener("click", onDocClick);
    },
  };
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

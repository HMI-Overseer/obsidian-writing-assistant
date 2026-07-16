import { setIcon } from "obsidian";
import type { ModelAvailabilityState, ProviderOption } from "../shared/types";
import { ModelDropdownView } from "../chat/models/ModelDropdownView";
import type { ModelDropdownDeps } from "../chat/models/ModelDropdownView";

export { pluginModelDropdownDeps } from "../chat/models/ModelDropdownView";
export type { ModelDropdownDeps } from "../chat/models/ModelDropdownView";

/* ════════════════════════════════════════════════════════════════════════════
 *  Sub-components, lightweight wrappers around native HTML elements
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
  private disabled = false;
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
    if (this.disabled) return;
    this.setValue(!this.value);
    this.changeCb?.(this.value);
  }

  /** An inert (auth-gated) toggle: rendered, but clicks and keys are ignored. */
  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    this.toggleEl.classList.toggle("is-disabled", disabled);
    this.toggleEl.setAttribute("aria-disabled", String(disabled));
    return this;
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

  onClick(cb: (evt: MouseEvent) => unknown): this {
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
 *  SettingItem, drop-in replacement for Obsidian's Setting class that
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
 *  Model selector, custom dropdown with availability status indicators
 * ════════════════════════════════════════════════════════════════════════ */

export interface ModelSelectorItem {
  id: string;
  name: string;
  modelId: string;
  provider: ProviderOption;
}

export interface ModelSelectorRefs {
  wrapEl: HTMLElement;
  /** Programmatically update the selected model and refresh the UI. */
  setSelected: (model: ModelSelectorItem | null) => void;
  /** Refresh availability from the service and return the current state. */
  refreshAvailability: () => Promise<ModelAvailabilityState>;
  /** Flash the selector to draw user attention (e.g. model not loaded). */
  retriggerAttention: () => void;
  /** Cleanup function, removes the document click listener. */
  destroy: () => void;
}

/**
 * At most one settings model dropdown is open at a time. Trigger and interior
 * clicks stopPropagation (so a dropdown doesn't dismiss itself), which also
 * hides those clicks from every OTHER open selector's document click-away;
 * without this registry, two adjacent selectors (e.g. the Knowledge Graph
 * tab's completion + embedding pickers) would overlay each other.
 */
let closeOpenModelSelector: (() => void) | null = null;

/**
 * Creates a custom model selector: a trigger with a status dot, opening the
 * shared {@link ModelDropdownView} interior (search, provider rail, favorite
 * stars). Same anatomy as the chat header's selector, minus its
 * profile-settings popover.
 */
export function createModelSelector(
  containerEl: HTMLElement,
  models: ModelSelectorItem[],
  deps: ModelDropdownDeps,
  opts: {
    initial: ModelSelectorItem | null;
    placeholder?: string;
    onSelect: (model: ModelSelectorItem | null) => void;
  },
): ModelSelectorRefs {
  let selected = opts.initial;
  let isOpen = false;

  const wrapEl = containerEl.createDiv({ cls: "lmsa-settings-model-selector-wrap" });
  const btn = wrapEl.createDiv({ cls: "lmsa-settings-model-selector" });
  const statusEl = btn.createEl("span", { cls: "lmsa-model-selector-status is-unknown" });
  const labelEl = btn.createEl("span", {
    cls: "lmsa-settings-model-selector-label",
    text: selected?.name ?? (opts.placeholder ?? "Select model..."),
  });
  const chevronEl = btn.createEl("span", { cls: "lmsa-settings-model-selector-chevron" });
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

  /** Refresh local discovery only when the selection could need it (non-cloud). */
  async function refreshAvailability(): Promise<void> {
    if (selected?.modelId && deps.getAvailability(selected.modelId, selected.provider) !== "cloud") {
      try { await deps.refreshLocalModels(); } catch { /* handled by service */ }
    }
    updateStatus();
  }

  // ── Open / close ──

  // A document-level click closes an open dropdown. Scoped to the open state
  // (added in open, removed in close) so the listener never outlives the
  // dropdown: this settings helper has no Component to hang registerDomEvent on,
  // and a never-removed document listener accumulates across settings re-renders.
  const onDocClick = (): void => { if (isOpen) close(); };

  function close(): void {
    if (closeOpenModelSelector === close) closeOpenModelSelector = null;
    document.removeEventListener("click", onDocClick);
    dropdownEl.addClass("lmsa-hidden");
    isOpen = false;
    btn.removeClass("is-active");
    chevronEl.empty();
    setIcon(chevronEl, "chevron-down");
  }

  function open(): void {
    closeOpenModelSelector?.();
    closeOpenModelSelector = close;
    document.addEventListener("click", onDocClick);
    dropdownEl.empty();
    dropdownEl.removeClass("lmsa-hidden");
    isOpen = true;
    btn.addClass("is-active");
    chevronEl.empty();
    setIcon(chevronEl, "chevron-up");

    const view = new ModelDropdownView<ModelSelectorItem>(deps, dropdownEl, {
      getModels: () => models,
      getSelectedId: () => selected?.id ?? "",
      onSelect: (model) => {
        selected = model;
        labelEl.setText(model.name);
        updateStatus();
        close();
        opts.onSelect(model);
      },
      onAfterRefresh: () => updateStatus(),
    });
    view.render();
  }

  // ── Events ──

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (isOpen) close(); else open();
  });

  // Interior clicks (search field, rail, star toggles) must not reach the
  // document click-away handler above.
  dropdownEl.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  // ── Attention effect ──

  let attentionTimer: number | null = null;

  function clearAttention(): void {
    if (attentionTimer !== null) {
      window.clearTimeout(attentionTimer);
      attentionTimer = null;
    }
    btn.removeClass("is-attention");
  }

  // ── Init ──
  void refreshAvailability();

  return {
    wrapEl,
    setSelected(model) {
      selected = model;
      labelEl.setText(model?.name ?? (opts.placeholder ?? "Select model..."));
      updateStatus();
    },
    async refreshAvailability(): Promise<ModelAvailabilityState> {
      await refreshAvailability();
      if (!selected?.modelId) return "unknown";
      return deps.getAvailability(selected.modelId, selected.provider);
    },
    retriggerAttention(): void {
      clearAttention();
      btn.removeClass("is-attention");
      void btn.offsetWidth;
      btn.addClass("is-attention");
      attentionTimer = window.setTimeout(() => {
        attentionTimer = null;
        btn.removeClass("is-attention");
      }, 700);
    },
    destroy() {
      clearAttention();
      if (closeOpenModelSelector === close) closeOpenModelSelector = null;
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

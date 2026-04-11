import type { ReasoningLevel } from "../../../shared/types";

export interface ReasoningControlOptions {
  value: ReasoningLevel | null;
  onChange: (value: ReasoningLevel | null) => void;
}

const REASONING_LEVELS: ReasoningLevel[] = ["off", "low", "medium", "high", "on"];

/**
 * Toggle + dropdown for reasoning level selection.
 */
export class ReasoningControl {
  private toggleEl: HTMLInputElement | null = null;
  private selectEl: HTMLSelectElement | null = null;
  private row: HTMLElement | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly opts: ReasoningControlOptions,
  ) {
    this.render();
  }

  private render(): void {
    const section = this.container.createDiv({ cls: "lmsa-params-section" });

    const labelRow = section.createDiv({ cls: "lmsa-params-toggle-row" });
    this.toggleEl = labelRow.createEl("input", {
      cls: "lmsa-params-toggle",
      attr: { type: "checkbox" },
    }) as HTMLInputElement;
    labelRow.createEl("label", { cls: "lmsa-params-label", text: "Reasoning" });

    this.row = section.createDiv({ cls: "lmsa-params-input-row" });
    this.selectEl = this.row.createEl("select", {
      cls: "lmsa-params-select",
    }) as HTMLSelectElement;

    for (const level of REASONING_LEVELS) {
      this.selectEl.createEl("option", {
        text: level.charAt(0).toUpperCase() + level.slice(1),
        attr: { value: level },
      });
    }

    // Initialize from value
    const hasReasoning = this.opts.value !== null;
    this.toggleEl.checked = hasReasoning;
    this.selectEl.value = this.opts.value ?? "off";
    this.row.toggleClass("is-disabled", !hasReasoning);
    this.selectEl.disabled = !hasReasoning;

    this.toggleEl.addEventListener("change", () => {
      if (!this.toggleEl || !this.selectEl || !this.row) return;
      const on = this.toggleEl.checked;
      this.selectEl.disabled = !on;
      this.row.toggleClass("is-disabled", !on);
      if (on) {
        this.opts.onChange(this.selectEl.value as ReasoningLevel);
      } else {
        this.opts.onChange(null);
      }
    });

    this.selectEl.addEventListener("change", () => {
      if (!this.selectEl) return;
      this.opts.onChange(this.selectEl.value as ReasoningLevel);
    });
  }

  setDisabled(disabled: boolean): void {
    if (this.toggleEl) this.toggleEl.disabled = disabled;
    if (this.selectEl) this.selectEl.disabled = disabled;
  }
}

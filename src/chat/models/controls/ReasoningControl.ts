import type { ReasoningLevel } from "../../../shared/types";
import { REASONING_LEVEL_LABELS } from "../../../shared/reasoning";

export interface ReasoningControlOptions {
  value: ReasoningLevel | null;
  /** The levels the active model actually offers (resolved set, §3.1). */
  levels: ReasoningLevel[];
  onChange: (value: ReasoningLevel | null) => void;
}

/**
 * Toggle + dropdown for reasoning level selection. Off = null = the model's own
 * default (nothing is sent). The dropdown offers only the model's resolved
 * level set; with no stored value it rests on the middle level as a cursor
 * affordance only, nothing is stored or sent until the user commits.
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

    for (const level of this.opts.levels) {
      this.selectEl.createEl("option", {
        text: REASONING_LEVEL_LABELS[level],
        attr: { value: level },
      });
    }

    // Initialize from value; without one, rest the cursor on the middle level.
    const levels = this.opts.levels;
    const middle = levels[Math.floor((levels.length - 1) / 2)];
    const hasReasoning = this.opts.value !== null;
    this.toggleEl.checked = hasReasoning;
    this.selectEl.value = this.opts.value ?? middle ?? "";
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

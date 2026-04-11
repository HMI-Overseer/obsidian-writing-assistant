export interface TemperatureControlOptions {
  value: number;
  onChange: (value: number) => void;
}

/**
 * Always-visible temperature slider (not nullable).
 */
export class TemperatureControl {
  private sliderEl: HTMLInputElement | null = null;
  private valueEl: HTMLElement | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly opts: TemperatureControlOptions,
  ) {
    this.render();
  }

  private render(): void {
    const section = this.container.createDiv({ cls: "lmsa-params-section" });
    section.createEl("label", { cls: "lmsa-params-label", text: "Temperature" });

    const sliderRow = section.createDiv({ cls: "lmsa-params-slider-row" });
    this.sliderEl = sliderRow.createEl("input", {
      cls: "lmsa-params-slider",
      attr: { type: "range", min: "0", max: "1", step: "0.05" },
    }) as HTMLInputElement;

    this.valueEl = sliderRow.createEl("span", {
      cls: "lmsa-params-slider-value",
      text: this.opts.value.toFixed(2),
    });

    this.sliderEl.value = String(this.opts.value);

    this.sliderEl.addEventListener("input", () => {
      if (!this.sliderEl || !this.valueEl) return;
      const value = parseFloat(this.sliderEl.value);
      this.valueEl.textContent = value.toFixed(2);
    });

    this.sliderEl.addEventListener("change", () => {
      if (!this.sliderEl) return;
      const value = parseFloat(this.sliderEl.value);
      this.opts.onChange(value);
    });
  }

  setDisabled(disabled: boolean): void {
    if (this.sliderEl) this.sliderEl.disabled = disabled;
  }
}

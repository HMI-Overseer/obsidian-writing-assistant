export interface SliderParamOptions {
  label: string;
  min: number;
  max: number;
  step: number;
  decimals: number;
  value: number | null;
  onChange: (value: number | null) => void;
}

interface SliderRefs {
  toggle: HTMLInputElement;
  slider: HTMLInputElement;
  valueDisplay: HTMLElement;
  row: HTMLElement;
}

/**
 * A nullable slider control with a toggle checkbox.
 * When the toggle is off, the value is null.
 */
export class SliderParamControl {
  private refs: SliderRefs | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly opts: SliderParamOptions,
  ) {
    this.render();
  }

  private render(): void {
    const section = this.container.createDiv({ cls: "lmsa-params-section" });

    const labelRow = section.createDiv({ cls: "lmsa-params-toggle-row" });
    const toggle = labelRow.createEl("input", {
      cls: "lmsa-params-toggle",
      attr: { type: "checkbox" },
    }) as HTMLInputElement;
    labelRow.createEl("label", { cls: "lmsa-params-label", text: this.opts.label });

    const sliderRow = section.createDiv({ cls: "lmsa-params-slider-row" });
    const slider = sliderRow.createEl("input", {
      cls: "lmsa-params-slider",
      attr: {
        type: "range",
        min: String(this.opts.min),
        max: String(this.opts.max),
        step: String(this.opts.step),
      },
    }) as HTMLInputElement;

    const valueDisplay = sliderRow.createEl("span", {
      cls: "lmsa-params-slider-value",
      text: "—",
    });

    // Initialize from value
    const enabled = this.opts.value !== null;
    toggle.checked = enabled;
    slider.disabled = !enabled;
    sliderRow.toggleClass("is-disabled", !enabled);
    if (enabled && this.opts.value !== null) {
      slider.value = String(this.opts.value);
      valueDisplay.textContent = this.opts.value.toFixed(this.opts.decimals);
    }

    toggle.addEventListener("change", () => {
      const on = toggle.checked;
      slider.disabled = !on;
      sliderRow.toggleClass("is-disabled", !on);
      if (on) {
        const mid = (this.opts.max - this.opts.min) / 2 + this.opts.min;
        slider.value = String(mid);
        valueDisplay.textContent = mid.toFixed(this.opts.decimals);
        this.opts.onChange(mid);
      } else {
        valueDisplay.textContent = "—";
        this.opts.onChange(null);
      }
    });

    slider.addEventListener("input", () => {
      valueDisplay.textContent = parseFloat(slider.value).toFixed(this.opts.decimals);
    });

    slider.addEventListener("change", () => {
      this.opts.onChange(parseFloat(slider.value));
    });

    this.refs = { toggle, slider, valueDisplay, row: sliderRow };
  }

  setDisabled(disabled: boolean): void {
    if (!this.refs) return;
    this.refs.toggle.disabled = disabled;
    this.refs.slider.disabled = disabled;
  }
}

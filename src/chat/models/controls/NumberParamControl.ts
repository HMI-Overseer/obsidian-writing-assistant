export interface NumberParamOptions {
  label: string;
  min: number;
  max: number;
  step: number;
  placeholder: string;
  value: number | null;
  onChange: (value: number | null) => void;
}

interface NumberRefs {
  toggle: HTMLInputElement;
  input: HTMLInputElement;
  row: HTMLElement;
}

/**
 * A nullable number input control with a toggle checkbox.
 * When the toggle is off, the value is null.
 */
export class NumberParamControl {
  private refs: NumberRefs | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly opts: NumberParamOptions,
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

    const inputRow = section.createDiv({ cls: "lmsa-params-input-row" });
    const input = inputRow.createEl("input", {
      cls: "lmsa-params-number-input",
      attr: {
        type: "number",
        min: String(this.opts.min),
        max: String(this.opts.max),
        step: String(this.opts.step),
        placeholder: this.opts.placeholder,
      },
    }) as HTMLInputElement;

    // Initialize from value
    const enabled = this.opts.value !== null;
    toggle.checked = enabled;
    input.disabled = !enabled;
    inputRow.toggleClass("is-disabled", !enabled);
    if (enabled) {
      input.value = String(this.opts.value);
    }

    toggle.addEventListener("change", () => {
      const on = toggle.checked;
      input.disabled = !on;
      inputRow.toggleClass("is-disabled", !on);
      if (!on) {
        input.value = "";
        this.opts.onChange(null);
      }
    });

    input.addEventListener("change", () => {
      const raw = input.value.trim();
      if (raw === "") {
        this.opts.onChange(null);
        toggle.checked = false;
        input.disabled = true;
        inputRow.addClass("is-disabled");
      } else {
        const num = parseFloat(raw);
        if (!isNaN(num)) {
          this.opts.onChange(num);
        }
      }
    });

    this.refs = { toggle, input, row: inputRow };
  }

  setDisabled(disabled: boolean): void {
    if (!this.refs) return;
    this.refs.toggle.disabled = disabled;
    this.refs.input.disabled = disabled;
  }
}

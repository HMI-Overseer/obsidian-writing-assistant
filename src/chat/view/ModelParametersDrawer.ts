import { setIcon } from "obsidian";
import type { ReasoningLevel } from "../../shared/types";

export type ParamsDrawerCallbacks = {
  onClose: () => void;
  getSettings: () => {
    globalSystemPrompt: string;
    globalTemperature: number;
    globalMaxTokens: number | null;
    globalTopP: number | null;
    globalTopK: number | null;
    globalMinP: number | null;
    globalRepeatPenalty: number | null;
    globalReasoning: ReasoningLevel | null;
  };
  onSystemPromptChange: (value: string) => Promise<void>;
  onTemperatureChange: (value: number) => Promise<void>;
  onMaxTokensChange: (value: number | null) => Promise<void>;
  onTopPChange: (value: number | null) => Promise<void>;
  onTopKChange: (value: number | null) => Promise<void>;
  onMinPChange: (value: number | null) => Promise<void>;
  onRepeatPenaltyChange: (value: number | null) => Promise<void>;
  onReasoningChange: (value: ReasoningLevel | null) => Promise<void>;
};

interface NullableSliderRefs {
  toggle: HTMLInputElement;
  slider: HTMLInputElement;
  valueDisplay: HTMLElement;
  row: HTMLElement;
}

interface NullableNumberRefs {
  toggle: HTMLInputElement;
  input: HTMLInputElement;
  row: HTMLElement;
}

export class ModelParametersDrawer {
  private containerEl: HTMLElement;
  private anchorEl: HTMLElement;
  private drawerEl: HTMLElement;
  private promptTextareaEl!: HTMLTextAreaElement;
  private temperatureSliderEl!: HTMLInputElement;
  private temperatureValueEl!: HTMLElement;
  private maxTokensRefs!: NullableNumberRefs;
  private topPRefs!: NullableSliderRefs;
  private topKRefs!: NullableNumberRefs;
  private minPRefs!: NullableSliderRefs;
  private repeatPenaltyRefs!: NullableSliderRefs;
  private reasoningToggleEl!: HTMLInputElement;
  private reasoningSelectEl!: HTMLSelectElement;
  private reasoningRow!: HTMLElement;
  private callbacks: ParamsDrawerCallbacks;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(containerEl: HTMLElement, anchorEl: HTMLElement, callbacks: ParamsDrawerCallbacks) {
    this.containerEl = containerEl;
    this.anchorEl = anchorEl;
    this.callbacks = callbacks;

    this.drawerEl = containerEl.createDiv({ cls: "lmsa-params-drawer" });
    this.drawerEl.addEventListener("click", (e) => e.stopPropagation());
    this.buildShell();
  }

  open(): void {
    this.positionAtAnchor();
    this.syncFromSettings();
    this.drawerEl.addClass("is-open");
  }

  close(): void {
    this.flushPendingSave();
    this.drawerEl.removeClass("is-open");
  }

  isOpen(): boolean {
    return this.drawerEl.hasClass("is-open");
  }

  private positionAtAnchor(): void {
    const containerRect = this.containerEl.getBoundingClientRect();
    const anchorRect = this.anchorEl.getBoundingClientRect();

    const top = anchorRect.top - containerRect.top;
    const right = containerRect.right - anchorRect.right;

    this.drawerEl.style.top = `${top}px`;
    this.drawerEl.style.right = `${right}px`;
  }

  destroy(): void {
    this.flushPendingSave();
  }

  private syncFromSettings(): void {
    const s = this.callbacks.getSettings();

    this.promptTextareaEl.value = s.globalSystemPrompt;
    this.temperatureSliderEl.value = String(s.globalTemperature);
    this.temperatureValueEl.textContent = s.globalTemperature.toFixed(2);

    this.syncNullableNumber(this.maxTokensRefs, s.globalMaxTokens);
    this.syncNullableSlider(this.topPRefs, s.globalTopP, 2);
    this.syncNullableNumber(this.topKRefs, s.globalTopK);
    this.syncNullableSlider(this.minPRefs, s.globalMinP, 2);
    this.syncNullableSlider(this.repeatPenaltyRefs, s.globalRepeatPenalty, 2);

    const hasReasoning = s.globalReasoning !== null;
    this.reasoningToggleEl.checked = hasReasoning;
    this.reasoningSelectEl.value = s.globalReasoning ?? "off";
    this.reasoningRow.toggleClass("is-disabled", !hasReasoning);
    this.reasoningSelectEl.disabled = !hasReasoning;
  }

  private syncNullableSlider(refs: NullableSliderRefs, value: number | null, decimals: number): void {
    const enabled = value !== null;
    refs.toggle.checked = enabled;
    refs.slider.disabled = !enabled;
    refs.row.toggleClass("is-disabled", !enabled);
    if (enabled) {
      refs.slider.value = String(value);
      refs.valueDisplay.textContent = value.toFixed(decimals);
    } else {
      refs.valueDisplay.textContent = "—";
    }
  }

  private syncNullableNumber(refs: NullableNumberRefs, value: number | null): void {
    const enabled = value !== null;
    refs.toggle.checked = enabled;
    refs.input.disabled = !enabled;
    refs.row.toggleClass("is-disabled", !enabled);
    refs.input.value = enabled ? String(value) : "";
  }

  private buildShell(): void {
    const header = this.drawerEl.createDiv({ cls: "lmsa-params-header" });
    header.createEl("span", { cls: "lmsa-params-title", text: "Model Parameters" });

    const closeBtn = header.createEl("button", {
      cls: "lmsa-params-close-btn",
      attr: { "aria-label": "Close" },
    });
    setIcon(closeBtn, "x");
    closeBtn.addEventListener("click", () => this.callbacks.onClose());

    const body = this.drawerEl.createDiv({ cls: "lmsa-params-body" });

    // System Prompt
    const promptSection = body.createDiv({ cls: "lmsa-params-section" });
    promptSection.createEl("label", { cls: "lmsa-params-label", text: "System Prompt" });
    this.promptTextareaEl = promptSection.createEl("textarea", {
      cls: "lmsa-params-textarea",
      attr: { placeholder: "Enter a system prompt...", rows: "6" },
    }) as HTMLTextAreaElement;

    this.promptTextareaEl.addEventListener("input", () => {
      this.debounceSave(() => {
        void this.callbacks.onSystemPromptChange(this.promptTextareaEl.value);
      });
    });

    // Temperature (always-on, non-nullable)
    this.buildTemperatureSection(body);

    // Max Tokens (nullable number input)
    this.maxTokensRefs = this.buildNullableNumberSection(body, {
      label: "Max Tokens",
      min: 1,
      max: 32768,
      step: 1,
      placeholder: "e.g. 2000",
      onChange: (v) => void this.callbacks.onMaxTokensChange(v),
    });

    // Top P (nullable slider)
    this.topPRefs = this.buildNullableSliderSection(body, {
      label: "Top P",
      min: 0,
      max: 1,
      step: 0.05,
      decimals: 2,
      onChange: (v) => void this.callbacks.onTopPChange(v),
    });

    // Top K (nullable number input)
    this.topKRefs = this.buildNullableNumberSection(body, {
      label: "Top K",
      min: 1,
      max: 500,
      step: 1,
      placeholder: "e.g. 40",
      onChange: (v) => void this.callbacks.onTopKChange(v),
    });

    // Min P (nullable slider)
    this.minPRefs = this.buildNullableSliderSection(body, {
      label: "Min P",
      min: 0,
      max: 1,
      step: 0.01,
      decimals: 2,
      onChange: (v) => void this.callbacks.onMinPChange(v),
    });

    // Repeat Penalty (nullable slider)
    this.repeatPenaltyRefs = this.buildNullableSliderSection(body, {
      label: "Repeat Penalty",
      min: 0.5,
      max: 2.0,
      step: 0.05,
      decimals: 2,
      onChange: (v) => void this.callbacks.onRepeatPenaltyChange(v),
    });

    // Reasoning (nullable dropdown)
    this.buildReasoningSection(body);
  }

  private buildTemperatureSection(body: HTMLElement): void {
    const section = body.createDiv({ cls: "lmsa-params-section" });
    section.createEl("label", { cls: "lmsa-params-label", text: "Temperature" });

    const sliderRow = section.createDiv({ cls: "lmsa-params-slider-row" });
    this.temperatureSliderEl = sliderRow.createEl("input", {
      cls: "lmsa-params-slider",
      attr: { type: "range", min: "0", max: "1", step: "0.05" },
    }) as HTMLInputElement;

    this.temperatureValueEl = sliderRow.createEl("span", {
      cls: "lmsa-params-slider-value",
      text: "0.70",
    });

    this.temperatureSliderEl.addEventListener("input", () => {
      const value = parseFloat(this.temperatureSliderEl.value);
      this.temperatureValueEl.textContent = value.toFixed(2);
    });

    this.temperatureSliderEl.addEventListener("change", () => {
      const value = parseFloat(this.temperatureSliderEl.value);
      void this.callbacks.onTemperatureChange(value);
    });
  }

  private buildNullableSliderSection(
    body: HTMLElement,
    opts: {
      label: string;
      min: number;
      max: number;
      step: number;
      decimals: number;
      onChange: (value: number | null) => void;
    }
  ): NullableSliderRefs {
    const section = body.createDiv({ cls: "lmsa-params-section" });

    const labelRow = section.createDiv({ cls: "lmsa-params-toggle-row" });
    const toggle = labelRow.createEl("input", {
      cls: "lmsa-params-toggle",
      attr: { type: "checkbox" },
    }) as HTMLInputElement;
    labelRow.createEl("label", { cls: "lmsa-params-label", text: opts.label });

    const sliderRow = section.createDiv({ cls: "lmsa-params-slider-row" });
    const slider = sliderRow.createEl("input", {
      cls: "lmsa-params-slider",
      attr: {
        type: "range",
        min: String(opts.min),
        max: String(opts.max),
        step: String(opts.step),
      },
    }) as HTMLInputElement;

    const valueDisplay = sliderRow.createEl("span", {
      cls: "lmsa-params-slider-value",
      text: "—",
    });

    toggle.addEventListener("change", () => {
      const enabled = toggle.checked;
      slider.disabled = !enabled;
      sliderRow.toggleClass("is-disabled", !enabled);
      if (enabled) {
        const mid = ((opts.max - opts.min) / 2 + opts.min);
        slider.value = String(mid);
        valueDisplay.textContent = mid.toFixed(opts.decimals);
        opts.onChange(mid);
      } else {
        valueDisplay.textContent = "—";
        opts.onChange(null);
      }
    });

    slider.addEventListener("input", () => {
      valueDisplay.textContent = parseFloat(slider.value).toFixed(opts.decimals);
    });

    slider.addEventListener("change", () => {
      opts.onChange(parseFloat(slider.value));
    });

    return { toggle, slider, valueDisplay, row: sliderRow };
  }

  private buildNullableNumberSection(
    body: HTMLElement,
    opts: {
      label: string;
      min: number;
      max: number;
      step: number;
      placeholder: string;
      onChange: (value: number | null) => void;
    }
  ): NullableNumberRefs {
    const section = body.createDiv({ cls: "lmsa-params-section" });

    const labelRow = section.createDiv({ cls: "lmsa-params-toggle-row" });
    const toggle = labelRow.createEl("input", {
      cls: "lmsa-params-toggle",
      attr: { type: "checkbox" },
    }) as HTMLInputElement;
    labelRow.createEl("label", { cls: "lmsa-params-label", text: opts.label });

    const inputRow = section.createDiv({ cls: "lmsa-params-input-row" });
    const input = inputRow.createEl("input", {
      cls: "lmsa-params-number-input",
      attr: {
        type: "number",
        min: String(opts.min),
        max: String(opts.max),
        step: String(opts.step),
        placeholder: opts.placeholder,
      },
    }) as HTMLInputElement;

    toggle.addEventListener("change", () => {
      const enabled = toggle.checked;
      input.disabled = !enabled;
      inputRow.toggleClass("is-disabled", !enabled);
      if (!enabled) {
        input.value = "";
        opts.onChange(null);
      }
    });

    input.addEventListener("change", () => {
      const raw = input.value.trim();
      if (raw === "") {
        opts.onChange(null);
        toggle.checked = false;
        input.disabled = true;
        inputRow.addClass("is-disabled");
      } else {
        const num = parseFloat(raw);
        if (!isNaN(num)) {
          opts.onChange(num);
        }
      }
    });

    return { toggle, input, row: inputRow };
  }

  private buildReasoningSection(body: HTMLElement): void {
    const section = body.createDiv({ cls: "lmsa-params-section" });

    const labelRow = section.createDiv({ cls: "lmsa-params-toggle-row" });
    this.reasoningToggleEl = labelRow.createEl("input", {
      cls: "lmsa-params-toggle",
      attr: { type: "checkbox" },
    }) as HTMLInputElement;
    labelRow.createEl("label", { cls: "lmsa-params-label", text: "Reasoning" });

    this.reasoningRow = section.createDiv({ cls: "lmsa-params-input-row" });
    this.reasoningSelectEl = this.reasoningRow.createEl("select", {
      cls: "lmsa-params-select",
    }) as HTMLSelectElement;

    const levels: ReasoningLevel[] = ["off", "low", "medium", "high", "on"];
    for (const level of levels) {
      this.reasoningSelectEl.createEl("option", {
        text: level.charAt(0).toUpperCase() + level.slice(1),
        attr: { value: level },
      });
    }

    this.reasoningToggleEl.addEventListener("change", () => {
      const enabled = this.reasoningToggleEl.checked;
      this.reasoningSelectEl.disabled = !enabled;
      this.reasoningRow.toggleClass("is-disabled", !enabled);
      if (enabled) {
        void this.callbacks.onReasoningChange(this.reasoningSelectEl.value as ReasoningLevel);
      } else {
        void this.callbacks.onReasoningChange(null);
      }
    });

    this.reasoningSelectEl.addEventListener("change", () => {
      void this.callbacks.onReasoningChange(this.reasoningSelectEl.value as ReasoningLevel);
    });
  }

  private debounceSave(fn: () => void): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      fn();
    }, 500);
  }

  private flushPendingSave(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      void this.callbacks.onSystemPromptChange(this.promptTextareaEl.value);
    }
  }
}

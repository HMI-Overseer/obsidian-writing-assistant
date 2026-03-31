import type {
  CompletionModel,
  AnthropicCacheSettings,
  CacheTtl,
  ReasoningLevel,
} from "../../shared/types";
import type { ChatLayoutRefs } from "../types";

export type ProfileSettingsCallbacks = {
  getActiveModel: () => CompletionModel | null;
  onCacheSettingsChange: (modelId: string, settings: AnthropicCacheSettings) => Promise<void>;
  getParamSettings: () => {
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

export class ProfileSettingsPopover {
  private popoverOpen = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onBtnClick: (event: MouseEvent) => void;
  private readonly onPopoverClick: (event: MouseEvent) => void;

  // Parameter control refs (populated when LM Studio section renders)
  private promptTextareaEl: HTMLTextAreaElement | null = null;
  private temperatureSliderEl: HTMLInputElement | null = null;
  private temperatureValueEl: HTMLElement | null = null;
  private maxTokensRefs: NullableNumberRefs | null = null;
  private topPRefs: NullableSliderRefs | null = null;
  private topKRefs: NullableNumberRefs | null = null;
  private minPRefs: NullableSliderRefs | null = null;
  private repeatPenaltyRefs: NullableSliderRefs | null = null;
  private reasoningToggleEl: HTMLInputElement | null = null;
  private reasoningSelectEl: HTMLSelectElement | null = null;
  private reasoningRow: HTMLElement | null = null;

  constructor(
    private readonly refs: Pick<
      ChatLayoutRefs,
      "profileSettingsBtn" | "profileSettingsPopoverEl"
    >,
    private readonly callbacks: ProfileSettingsCallbacks
  ) {
    this.onBtnClick = (event: MouseEvent) => {
      event.stopPropagation();
      if (this.popoverOpen) {
        this.close();
      } else {
        this.open();
      }
    };

    this.onPopoverClick = (event: MouseEvent) => {
      event.stopPropagation();
    };

    this.refs.profileSettingsBtn.addEventListener("click", this.onBtnClick);
    this.refs.profileSettingsPopoverEl.addEventListener("click", this.onPopoverClick);
  }

  syncVisibility(): void {
    const model = this.callbacks.getActiveModel();
    if (!model) {
      this.refs.profileSettingsBtn.style.display = "none";
      if (this.popoverOpen) this.close();
      return;
    }
    this.refs.profileSettingsBtn.style.display = "";
  }

  open(): void {
    const model = this.callbacks.getActiveModel();
    if (!model) return;

    this.popoverOpen = true;
    this.refs.profileSettingsPopoverEl.style.display = "block";
    this.renderContent(model);
  }

  close(): void {
    this.flushPendingSave();
    this.popoverOpen = false;
    this.refs.profileSettingsPopoverEl.style.display = "none";
  }

  isOpen(): boolean {
    return this.popoverOpen;
  }

  destroy(): void {
    this.flushPendingSave();
    this.close();
    this.refs.profileSettingsBtn.removeEventListener("click", this.onBtnClick);
    this.refs.profileSettingsPopoverEl.removeEventListener("click", this.onPopoverClick);
  }

  // ---------------------------------------------------------------------------
  // Content rendering
  // ---------------------------------------------------------------------------

  private renderContent(model: CompletionModel): void {
    const el = this.refs.profileSettingsPopoverEl;
    el.empty();
    this.clearParamRefs();

    const title = el.createDiv({
      cls: "lmsa-profile-popover-title",
      text: "Profile Settings",
    });
    title.createEl("span", {
      cls: "lmsa-profile-popover-subtitle",
      text: model.name,
    });

    const body = el.createDiv({ cls: "lmsa-profile-popover-body" });

    if (model.provider === "anthropic") {
      this.renderCacheSection(body, model);
    } else if (model.provider === "lmstudio") {
      this.renderParamsSection(body);
    } else {
      body.createDiv({
        cls: "lmsa-profile-popover-empty",
        text: "No configurable settings for this provider.",
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Anthropic — cache settings
  // ---------------------------------------------------------------------------

  private renderCacheSection(body: HTMLElement, model: CompletionModel): void {
    const settings: AnthropicCacheSettings = model.anthropicCacheSettings ?? {
      enabled: false,
      ttl: "default",
    };

    const section = body.createDiv({ cls: "lmsa-profile-popover-section" });
    section.createEl("div", {
      cls: "lmsa-profile-popover-section-title",
      text: "Prompt Caching",
    });

    // Toggle row
    const toggleRow = section.createDiv({ cls: "lmsa-profile-popover-row" });
    toggleRow.createEl("span", {
      cls: "lmsa-profile-popover-label",
      text: "Enable caching",
    });

    const toggleWrapper = toggleRow.createDiv({ cls: "lmsa-profile-popover-control" });
    const checkbox = toggleWrapper.createEl("input", {
      attr: { type: "checkbox" },
      cls: "lmsa-profile-toggle",
    }) as HTMLInputElement;
    checkbox.checked = settings.enabled;

    // TTL row
    const ttlRow = section.createDiv({ cls: "lmsa-profile-popover-row" });
    ttlRow.createEl("span", {
      cls: "lmsa-profile-popover-label",
      text: "Cache TTL",
    });

    const ttlWrapper = ttlRow.createDiv({ cls: "lmsa-profile-popover-control" });
    const ttlSelect = ttlWrapper.createEl("select", {
      cls: "lmsa-profile-ttl-select",
    }) as HTMLSelectElement;
    ttlSelect.createEl("option", { text: "5 min (default)", attr: { value: "default" } });
    ttlSelect.createEl("option", { text: "1 hour (2x write cost)", attr: { value: "1h" } });
    ttlSelect.value = settings.ttl;
    ttlSelect.disabled = !settings.enabled;

    const emitChange = async (updated: Partial<AnthropicCacheSettings>): Promise<void> => {
      const current: AnthropicCacheSettings = {
        enabled: checkbox.checked,
        ttl: ttlSelect.value as CacheTtl,
        ...updated,
      };
      ttlSelect.disabled = !current.enabled;
      await this.callbacks.onCacheSettingsChange(model.id, current);
    };

    checkbox.addEventListener("change", () => {
      void emitChange({ enabled: checkbox.checked });
    });

    ttlSelect.addEventListener("change", () => {
      void emitChange({ ttl: ttlSelect.value as CacheTtl });
    });
  }

  // ---------------------------------------------------------------------------
  // LM Studio — model parameters
  // ---------------------------------------------------------------------------

  private renderParamsSection(body: HTMLElement): void {
    const section = body.createDiv({ cls: "lmsa-profile-popover-section" });
    section.createEl("div", {
      cls: "lmsa-profile-popover-section-title",
      text: "Model Parameters",
    });

    const paramsBody = section.createDiv({ cls: "lmsa-params-body" });

    // System Prompt
    const promptSection = paramsBody.createDiv({ cls: "lmsa-params-section" });
    promptSection.createEl("label", { cls: "lmsa-params-label", text: "System Prompt" });
    this.promptTextareaEl = promptSection.createEl("textarea", {
      cls: "lmsa-params-textarea",
      attr: { placeholder: "Enter a system prompt...", rows: "6" },
    }) as HTMLTextAreaElement;

    this.promptTextareaEl.addEventListener("input", () => {
      this.debounceSave(() => {
        if (this.promptTextareaEl) {
          void this.callbacks.onSystemPromptChange(this.promptTextareaEl.value);
        }
      });
    });

    // Temperature
    this.buildTemperatureSection(paramsBody);

    // Max Tokens
    this.maxTokensRefs = this.buildNullableNumberSection(paramsBody, {
      label: "Max Tokens",
      min: 1,
      max: 32768,
      step: 1,
      placeholder: "e.g. 2000",
      onChange: (v) => void this.callbacks.onMaxTokensChange(v),
    });

    // Top P
    this.topPRefs = this.buildNullableSliderSection(paramsBody, {
      label: "Top P",
      min: 0,
      max: 1,
      step: 0.05,
      decimals: 2,
      onChange: (v) => void this.callbacks.onTopPChange(v),
    });

    // Top K
    this.topKRefs = this.buildNullableNumberSection(paramsBody, {
      label: "Top K",
      min: 1,
      max: 500,
      step: 1,
      placeholder: "e.g. 40",
      onChange: (v) => void this.callbacks.onTopKChange(v),
    });

    // Min P
    this.minPRefs = this.buildNullableSliderSection(paramsBody, {
      label: "Min P",
      min: 0,
      max: 1,
      step: 0.01,
      decimals: 2,
      onChange: (v) => void this.callbacks.onMinPChange(v),
    });

    // Repeat Penalty
    this.repeatPenaltyRefs = this.buildNullableSliderSection(paramsBody, {
      label: "Repeat Penalty",
      min: 0.5,
      max: 2.0,
      step: 0.05,
      decimals: 2,
      onChange: (v) => void this.callbacks.onRepeatPenaltyChange(v),
    });

    // Reasoning
    this.buildReasoningSection(paramsBody);

    this.syncFromSettings();
  }

  private buildTemperatureSection(container: HTMLElement): void {
    const section = container.createDiv({ cls: "lmsa-params-section" });
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
      if (!this.temperatureSliderEl || !this.temperatureValueEl) return;
      const value = parseFloat(this.temperatureSliderEl.value);
      this.temperatureValueEl.textContent = value.toFixed(2);
    });

    this.temperatureSliderEl.addEventListener("change", () => {
      if (!this.temperatureSliderEl) return;
      const value = parseFloat(this.temperatureSliderEl.value);
      void this.callbacks.onTemperatureChange(value);
    });
  }

  private buildNullableSliderSection(
    container: HTMLElement,
    opts: {
      label: string;
      min: number;
      max: number;
      step: number;
      decimals: number;
      onChange: (value: number | null) => void;
    }
  ): NullableSliderRefs {
    const section = container.createDiv({ cls: "lmsa-params-section" });

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
        const mid = (opts.max - opts.min) / 2 + opts.min;
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
    container: HTMLElement,
    opts: {
      label: string;
      min: number;
      max: number;
      step: number;
      placeholder: string;
      onChange: (value: number | null) => void;
    }
  ): NullableNumberRefs {
    const section = container.createDiv({ cls: "lmsa-params-section" });

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

  private buildReasoningSection(container: HTMLElement): void {
    const section = container.createDiv({ cls: "lmsa-params-section" });

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
      if (!this.reasoningToggleEl || !this.reasoningSelectEl || !this.reasoningRow) return;
      const enabled = this.reasoningToggleEl.checked;
      this.reasoningSelectEl.disabled = !enabled;
      this.reasoningRow.toggleClass("is-disabled", !enabled);
      if (enabled) {
        void this.callbacks.onReasoningChange(
          this.reasoningSelectEl.value as ReasoningLevel
        );
      } else {
        void this.callbacks.onReasoningChange(null);
      }
    });

    this.reasoningSelectEl.addEventListener("change", () => {
      if (!this.reasoningSelectEl) return;
      void this.callbacks.onReasoningChange(
        this.reasoningSelectEl.value as ReasoningLevel
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Sync & debounce helpers
  // ---------------------------------------------------------------------------

  private syncFromSettings(): void {
    const s = this.callbacks.getParamSettings();

    if (this.promptTextareaEl) {
      this.promptTextareaEl.value = s.globalSystemPrompt;
    }
    if (this.temperatureSliderEl && this.temperatureValueEl) {
      this.temperatureSliderEl.value = String(s.globalTemperature);
      this.temperatureValueEl.textContent = s.globalTemperature.toFixed(2);
    }
    if (this.maxTokensRefs) this.syncNullableNumber(this.maxTokensRefs, s.globalMaxTokens);
    if (this.topPRefs) this.syncNullableSlider(this.topPRefs, s.globalTopP, 2);
    if (this.topKRefs) this.syncNullableNumber(this.topKRefs, s.globalTopK);
    if (this.minPRefs) this.syncNullableSlider(this.minPRefs, s.globalMinP, 2);
    if (this.repeatPenaltyRefs) {
      this.syncNullableSlider(this.repeatPenaltyRefs, s.globalRepeatPenalty, 2);
    }

    if (this.reasoningToggleEl && this.reasoningSelectEl && this.reasoningRow) {
      const hasReasoning = s.globalReasoning !== null;
      this.reasoningToggleEl.checked = hasReasoning;
      this.reasoningSelectEl.value = s.globalReasoning ?? "off";
      this.reasoningRow.toggleClass("is-disabled", !hasReasoning);
      this.reasoningSelectEl.disabled = !hasReasoning;
    }
  }

  private syncNullableSlider(
    refs: NullableSliderRefs,
    value: number | null,
    decimals: number
  ): void {
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

  private clearParamRefs(): void {
    this.promptTextareaEl = null;
    this.temperatureSliderEl = null;
    this.temperatureValueEl = null;
    this.maxTokensRefs = null;
    this.topPRefs = null;
    this.topKRefs = null;
    this.minPRefs = null;
    this.repeatPenaltyRefs = null;
    this.reasoningToggleEl = null;
    this.reasoningSelectEl = null;
    this.reasoningRow = null;
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
      if (this.promptTextareaEl) {
        void this.callbacks.onSystemPromptChange(this.promptTextareaEl.value);
      }
    }
  }
}

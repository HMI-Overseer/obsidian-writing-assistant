import { setIcon } from "obsidian";
import type {
  CompletionModel,
  ProviderOption,
  ProviderProfile,
  AnthropicCacheSettings,
  CacheTtl,
  ReasoningLevel,
} from "../../shared/types";
import type { ProviderDescriptor, SamplingParamSupport } from "../../providers/types";
import type { ChatLayoutRefs } from "../types";

export type ProfileSettingsCallbacks = {
  getActiveModel: () => CompletionModel | null;
  getProfilesForProvider: (provider: ProviderOption) => ProviderProfile[];
  getActiveProfile: (provider: ProviderOption) => ProviderProfile;
  getProviderDescriptor: (provider: ProviderOption) => ProviderDescriptor;
  onProfileSelect: (profileId: string) => Promise<void>;
  onProfileCreate: (name: string, provider: ProviderOption) => Promise<ProviderProfile>;
  onProfileDelete: (profileId: string) => Promise<void>;
  onProfileUpdate: (profileId: string, patch: Partial<ProviderProfile>) => Promise<void>;
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

  // Profile selector refs
  private profileSelectEl: HTMLSelectElement | null = null;
  private deleteBtn: HTMLButtonElement | null = null;

  // Parameter control refs
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

  // Cache refs (Anthropic)
  private cacheToggleEl: HTMLInputElement | null = null;
  private cacheTtlSelectEl: HTMLSelectElement | null = null;

  constructor(
    private readonly refs: Pick<
      ChatLayoutRefs,
      "profileSettingsBtn" | "profileSettingsPopoverEl"
    >,
    private readonly callbacks: ProfileSettingsCallbacks,
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
      this.refs.profileSettingsBtn.addClass("lmsa-hidden");
      if (this.popoverOpen) this.close();
      return;
    }
    this.refs.profileSettingsBtn.removeClass("lmsa-hidden");
  }

  open(): void {
    const model = this.callbacks.getActiveModel();
    if (!model) return;

    this.popoverOpen = true;
    this.refs.profileSettingsPopoverEl.removeClass("lmsa-hidden");
    this.renderContent(model);
  }

  close(): void {
    this.flushPendingSave();
    this.popoverOpen = false;
    this.refs.profileSettingsPopoverEl.addClass("lmsa-hidden");
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

    const provider = model.provider;
    const descriptor = this.callbacks.getProviderDescriptor(provider);
    const profile = this.callbacks.getActiveProfile(provider);

    const title = el.createDiv({
      cls: "lmsa-profile-popover-title",
      text: "Model parameters",
    });
    title.createEl("span", {
      cls: "lmsa-profile-popover-subtitle",
      text: model.name,
    });

    // Profile selector
    this.renderProfileSelector(el, provider, profile);

    const body = el.createDiv({ cls: "lmsa-profile-popover-body" });

    // Default profile hint
    if (profile.isDefault) {
      body.createDiv({
        cls: "lmsa-profile-popover-hint",
        text: "Create a profile to customize parameters",
      });
    }

    // Sampling params section
    this.renderSamplingSection(body, descriptor.supportedParams, profile);

    // Anthropic cache section
    if (provider === "anthropic") {
      this.renderCacheSection(body, profile);
    }

    // Disable all controls when on default profile, enable otherwise
    this.setControlsDisabled(profile.isDefault);
  }

  // ---------------------------------------------------------------------------
  // Profile selector
  // ---------------------------------------------------------------------------

  private renderProfileSelector(
    container: HTMLElement,
    provider: ProviderOption,
    activeProfile: ProviderProfile,
  ): void {
    const row = container.createDiv({ cls: "lmsa-profile-selector-row" });

    this.profileSelectEl = row.createEl("select", {
      cls: "lmsa-profile-selector-select",
    }) as HTMLSelectElement;

    const profiles = this.callbacks.getProfilesForProvider(provider);
    for (const p of profiles) {
      this.profileSelectEl.createEl("option", {
        text: p.name,
        attr: { value: p.id },
      });
    }
    this.profileSelectEl.value = activeProfile.id;

    this.profileSelectEl.addEventListener("change", () => {
      if (!this.profileSelectEl) return;
      void this.callbacks.onProfileSelect(this.profileSelectEl.value).then(() => {
        const model = this.callbacks.getActiveModel();
        if (model) this.renderContent(model);
      });
    });

    const createBtn = row.createEl("button", {
      cls: "lmsa-profile-action-btn",
      attr: { "aria-label": "Create profile" },
    }) as HTMLButtonElement;
    setIcon(createBtn, "plus");

    createBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showCreateProfileInline(row, provider);
    });

    this.deleteBtn = row.createEl("button", {
      cls: "lmsa-profile-action-btn lmsa-profile-action-btn--danger",
      attr: { "aria-label": "Delete profile" },
    }) as HTMLButtonElement;
    setIcon(this.deleteBtn, "trash-2");
    this.deleteBtn.disabled = activeProfile.isDefault;
    if (activeProfile.isDefault) {
      this.deleteBtn.addClass("is-disabled");
    }

    this.deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!this.profileSelectEl) return;
      const selectedId = this.profileSelectEl.value;
      void this.callbacks.onProfileDelete(selectedId).then(() => {
        const model = this.callbacks.getActiveModel();
        if (model) this.renderContent(model);
      });
    });
  }

  private showCreateProfileInline(row: HTMLElement, provider: ProviderOption): void {
    // Check if inline form already exists
    const existing = row.parentElement?.querySelector(".lmsa-profile-create-inline");
    if (existing) return;

    const inline = row.insertAdjacentElement(
      "afterend",
      document.createElement("div"),
    ) as HTMLElement;
    inline.className = "lmsa-profile-create-inline";

    const input = inline.createEl("input", {
      cls: "lmsa-profile-create-input",
      attr: { type: "text", placeholder: "Profile name..." },
    }) as HTMLInputElement;

    const confirmBtn = inline.createEl("button", {
      cls: "lmsa-profile-action-btn",
      attr: { "aria-label": "Confirm" },
    }) as HTMLButtonElement;
    setIcon(confirmBtn, "check");

    const cancelBtn = inline.createEl("button", {
      cls: "lmsa-profile-action-btn",
      attr: { "aria-label": "Cancel" },
    }) as HTMLButtonElement;
    setIcon(cancelBtn, "x");

    input.focus();

    const doCreate = (): void => {
      const name = input.value.trim();
      if (!name) {
        inline.remove();
        return;
      }
      void this.callbacks.onProfileCreate(name, provider).then(() => {
        inline.remove();
        const model = this.callbacks.getActiveModel();
        if (model) this.renderContent(model);
      });
    };

    confirmBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      doCreate();
    });

    cancelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      inline.remove();
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        doCreate();
      } else if (e.key === "Escape") {
        inline.remove();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Sampling params section
  // ---------------------------------------------------------------------------

  private renderSamplingSection(
    body: HTMLElement,
    supportedParams: SamplingParamSupport,
    profile: ProviderProfile,
  ): void {
    const section = body.createDiv({ cls: "lmsa-profile-popover-section" });
    section.createEl("div", {
      cls: "lmsa-profile-popover-section-title",
      text: "Sampling",
    });

    const paramsBody = section.createDiv({ cls: "lmsa-params-body" });

    // System prompt (always shown)
    this.buildSystemPromptSection(paramsBody, profile);

    // Temperature (always supported)
    if (supportedParams.temperature) {
      this.buildTemperatureSection(paramsBody, profile);
    }

    // Max tokens
    if (supportedParams.maxTokens) {
      this.maxTokensRefs = this.buildNullableNumberSection(paramsBody, {
        label: "Max tokens",
        min: 1,
        max: 32768,
        step: 1,
        placeholder: "e.g. 2000",
        value: profile.maxTokens,
        onChange: (v) => this.emitProfileUpdate({ maxTokens: v }),
      });
    }

    // Top P
    if (supportedParams.topP) {
      this.topPRefs = this.buildNullableSliderSection(paramsBody, {
        label: "Top P",
        min: 0,
        max: 1,
        step: 0.05,
        decimals: 2,
        value: profile.topP,
        onChange: (v) => this.emitProfileUpdate({ topP: v }),
      });
    }

    // Top K
    if (supportedParams.topK) {
      this.topKRefs = this.buildNullableNumberSection(paramsBody, {
        label: "Top K",
        min: 1,
        max: 500,
        step: 1,
        placeholder: "e.g. 40",
        value: profile.topK,
        onChange: (v) => this.emitProfileUpdate({ topK: v }),
      });
    }

    // Min P
    if (supportedParams.minP) {
      this.minPRefs = this.buildNullableSliderSection(paramsBody, {
        label: "Min P",
        min: 0,
        max: 1,
        step: 0.01,
        decimals: 2,
        value: profile.minP,
        onChange: (v) => this.emitProfileUpdate({ minP: v }),
      });
    }

    // Repeat penalty
    if (supportedParams.repeatPenalty) {
      this.repeatPenaltyRefs = this.buildNullableSliderSection(paramsBody, {
        label: "Repeat penalty",
        min: 0.5,
        max: 2.0,
        step: 0.05,
        decimals: 2,
        value: profile.repeatPenalty,
        onChange: (v) => this.emitProfileUpdate({ repeatPenalty: v }),
      });
    }

    // Reasoning
    if (supportedParams.reasoning) {
      this.buildReasoningSection(paramsBody, profile);
    }
  }

  // ---------------------------------------------------------------------------
  // System prompt
  // ---------------------------------------------------------------------------

  private buildSystemPromptSection(container: HTMLElement, profile: ProviderProfile): void {
    const section = container.createDiv({ cls: "lmsa-params-section" });
    section.createEl("label", { cls: "lmsa-params-label", text: "System prompt" });
    this.promptTextareaEl = section.createEl("textarea", {
      cls: "lmsa-params-textarea",
      attr: { placeholder: "Enter a system prompt...", rows: "6" },
    }) as HTMLTextAreaElement;

    this.promptTextareaEl.value = profile.systemPrompt;

    this.promptTextareaEl.addEventListener("input", () => {
      this.debounceSave(() => {
        if (this.promptTextareaEl) {
          this.emitProfileUpdate({ systemPrompt: this.promptTextareaEl.value });
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Temperature
  // ---------------------------------------------------------------------------

  private buildTemperatureSection(container: HTMLElement, profile: ProviderProfile): void {
    const section = container.createDiv({ cls: "lmsa-params-section" });
    section.createEl("label", { cls: "lmsa-params-label", text: "Temperature" });

    const sliderRow = section.createDiv({ cls: "lmsa-params-slider-row" });
    this.temperatureSliderEl = sliderRow.createEl("input", {
      cls: "lmsa-params-slider",
      attr: { type: "range", min: "0", max: "1", step: "0.05" },
    }) as HTMLInputElement;

    this.temperatureValueEl = sliderRow.createEl("span", {
      cls: "lmsa-params-slider-value",
      text: profile.temperature.toFixed(2),
    });

    this.temperatureSliderEl.value = String(profile.temperature);

    this.temperatureSliderEl.addEventListener("input", () => {
      if (!this.temperatureSliderEl || !this.temperatureValueEl) return;
      const value = parseFloat(this.temperatureSliderEl.value);
      this.temperatureValueEl.textContent = value.toFixed(2);
    });

    this.temperatureSliderEl.addEventListener("change", () => {
      if (!this.temperatureSliderEl) return;
      const value = parseFloat(this.temperatureSliderEl.value);
      this.emitProfileUpdate({ temperature: value });
    });
  }

  // ---------------------------------------------------------------------------
  // Nullable slider param
  // ---------------------------------------------------------------------------

  private buildNullableSliderSection(
    container: HTMLElement,
    opts: {
      label: string;
      min: number;
      max: number;
      step: number;
      decimals: number;
      value: number | null;
      onChange: (value: number | null) => void;
    },
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

    // Initialize from profile value
    const enabled = opts.value !== null;
    toggle.checked = enabled;
    slider.disabled = !enabled;
    sliderRow.toggleClass("is-disabled", !enabled);
    if (enabled && opts.value !== null) {
      slider.value = String(opts.value);
      valueDisplay.textContent = opts.value.toFixed(opts.decimals);
    }

    toggle.addEventListener("change", () => {
      const on = toggle.checked;
      slider.disabled = !on;
      sliderRow.toggleClass("is-disabled", !on);
      if (on) {
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

  // ---------------------------------------------------------------------------
  // Nullable number param
  // ---------------------------------------------------------------------------

  private buildNullableNumberSection(
    container: HTMLElement,
    opts: {
      label: string;
      min: number;
      max: number;
      step: number;
      placeholder: string;
      value: number | null;
      onChange: (value: number | null) => void;
    },
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

    // Initialize from profile value
    const enabled = opts.value !== null;
    toggle.checked = enabled;
    input.disabled = !enabled;
    inputRow.toggleClass("is-disabled", !enabled);
    if (enabled) {
      input.value = String(opts.value);
    }

    toggle.addEventListener("change", () => {
      const on = toggle.checked;
      input.disabled = !on;
      inputRow.toggleClass("is-disabled", !on);
      if (!on) {
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

  // ---------------------------------------------------------------------------
  // Reasoning
  // ---------------------------------------------------------------------------

  private buildReasoningSection(container: HTMLElement, profile: ProviderProfile): void {
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

    // Initialize from profile
    const hasReasoning = profile.reasoning !== null;
    this.reasoningToggleEl.checked = hasReasoning;
    this.reasoningSelectEl.value = profile.reasoning ?? "off";
    this.reasoningRow.toggleClass("is-disabled", !hasReasoning);
    this.reasoningSelectEl.disabled = !hasReasoning;

    this.reasoningToggleEl.addEventListener("change", () => {
      if (!this.reasoningToggleEl || !this.reasoningSelectEl || !this.reasoningRow) return;
      const on = this.reasoningToggleEl.checked;
      this.reasoningSelectEl.disabled = !on;
      this.reasoningRow.toggleClass("is-disabled", !on);
      if (on) {
        this.emitProfileUpdate({
          reasoning: this.reasoningSelectEl.value as ReasoningLevel,
        });
      } else {
        this.emitProfileUpdate({ reasoning: null });
      }
    });

    this.reasoningSelectEl.addEventListener("change", () => {
      if (!this.reasoningSelectEl) return;
      this.emitProfileUpdate({
        reasoning: this.reasoningSelectEl.value as ReasoningLevel,
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Anthropic — cache settings
  // ---------------------------------------------------------------------------

  private renderCacheSection(body: HTMLElement, profile: ProviderProfile): void {
    const settings: AnthropicCacheSettings = profile.anthropicCacheSettings;

    const section = body.createDiv({ cls: "lmsa-profile-popover-section" });
    section.createEl("div", {
      cls: "lmsa-profile-popover-section-title",
      text: "Prompt caching",
    });

    // Toggle row
    const toggleRow = section.createDiv({ cls: "lmsa-profile-popover-row" });
    toggleRow.createEl("span", {
      cls: "lmsa-profile-popover-label",
      text: "Enable caching",
    });

    const toggleWrapper = toggleRow.createDiv({ cls: "lmsa-profile-popover-control" });
    this.cacheToggleEl = toggleWrapper.createEl("input", {
      attr: { type: "checkbox" },
      cls: "lmsa-profile-toggle",
    }) as HTMLInputElement;
    this.cacheToggleEl.checked = settings.enabled;

    // TTL row
    const ttlRow = section.createDiv({ cls: "lmsa-profile-popover-row" });
    ttlRow.createEl("span", {
      cls: "lmsa-profile-popover-label",
      text: "Cache TTL",
    });

    const ttlWrapper = ttlRow.createDiv({ cls: "lmsa-profile-popover-control" });
    this.cacheTtlSelectEl = ttlWrapper.createEl("select", {
      cls: "lmsa-profile-ttl-select",
    }) as HTMLSelectElement;
    this.cacheTtlSelectEl.createEl("option", { text: "5 min (default)", attr: { value: "default" } });
    this.cacheTtlSelectEl.createEl("option", { text: "1 hour (2x write cost)", attr: { value: "1h" } });
    this.cacheTtlSelectEl.value = settings.ttl;
    this.cacheTtlSelectEl.disabled = !settings.enabled;

    this.cacheToggleEl.addEventListener("change", () => {
      if (!this.cacheToggleEl || !this.cacheTtlSelectEl) return;
      const enabled = this.cacheToggleEl.checked;
      this.cacheTtlSelectEl.disabled = !enabled;
      this.emitProfileUpdate({
        anthropicCacheSettings: {
          enabled,
          ttl: this.cacheTtlSelectEl.value as CacheTtl,
        },
      });
    });

    this.cacheTtlSelectEl.addEventListener("change", () => {
      if (!this.cacheToggleEl || !this.cacheTtlSelectEl) return;
      this.emitProfileUpdate({
        anthropicCacheSettings: {
          enabled: this.cacheToggleEl.checked,
          ttl: this.cacheTtlSelectEl.value as CacheTtl,
        },
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private emitProfileUpdate(patch: Partial<ProviderProfile>): void {
    const model = this.callbacks.getActiveModel();
    if (!model) return;
    const profile = this.callbacks.getActiveProfile(model.provider);
    if (profile.isDefault) return;
    void this.callbacks.onProfileUpdate(profile.id, patch);
  }

  private setControlsDisabled(disabled: boolean): void {
    const el = this.refs.profileSettingsPopoverEl;
    const inputs = el.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      ".lmsa-params-body input, .lmsa-params-body select, .lmsa-params-body textarea, " +
      ".lmsa-profile-popover-section input, .lmsa-profile-popover-section select",
    );
    for (const input of inputs) {
      input.disabled = disabled;
    }
    el.toggleClass("is-default-profile", disabled);
  }

  private clearParamRefs(): void {
    this.profileSelectEl = null;
    this.deleteBtn = null;
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
    this.cacheToggleEl = null;
    this.cacheTtlSelectEl = null;
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
        this.emitProfileUpdate({ systemPrompt: this.promptTextareaEl.value });
      }
    }
  }
}

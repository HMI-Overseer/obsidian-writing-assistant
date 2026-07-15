import type {
  CompletionModel,
  ProviderOption,
  ProviderProfile,
  ReasoningLevel,
} from "../../shared/types";
import { PROVIDER_OPTIONS } from "../../shared/modelKeys";
import type { ProviderDescriptor, SamplingParamSupport } from "../../providers/types";
import type { ChatLayoutRefs } from "../types";
import { ProfileSelectorUI } from "./ProfileSelectorUI";
import { providerRailEntry, renderProviderRail } from "./ProviderRail";
import {
  TemperatureControl,
  SliderParamControl,
  NumberParamControl,
  ReasoningControl,
  CacheSettingsControl,
} from "./controls";

export type ProfileSettingsCallbacks = {
  getActiveModel: () => CompletionModel | null;
  isProviderEnabled: (provider: ProviderOption) => boolean;
  getProfilesForProvider: (provider: ProviderOption) => ProviderProfile[];
  getActiveProfile: (provider: ProviderOption) => ProviderProfile;
  getProviderDescriptor: (provider: ProviderOption) => ProviderDescriptor;
  onProfileSelect: (profileId: string, provider: ProviderOption) => Promise<void>;
  onProfileCreate: (name: string, provider: ProviderOption) => Promise<ProviderProfile>;
  onProfileDelete: (profileId: string) => Promise<void>;
  onProfileUpdate: (profileId: string, patch: Partial<ProviderProfile>) => Promise<void>;
  /** The active model's stored reasoning level, already clamped to its resolved set. */
  getModelReasoning: () => ReasoningLevel | null;
  /**
   * The active model's resolved level set (discovery > catalog > descriptor).
   * Resolved by the caller, which holds the availability service; empty = no
   * reasoning control rendered.
   */
  getModelReasoningLevels: () => ReasoningLevel[];
  /** Writes the active model's `reasoningByModelKey` entry (null clears it). */
  onModelReasoningChange: (level: ReasoningLevel | null) => Promise<void>;
};

export class ProfileSettingsPopover {
  private popoverOpen = false;
  /**
   * The provider whose profiles are on screen. Opens on the active model's
   * provider; the rail navigates to any other enabled provider so its profiles
   * can be edited (or copied from) without switching models.
   */
  private viewedProvider: ProviderOption | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onBtnClick: (event: MouseEvent) => void;
  private readonly onPopoverClick: (event: MouseEvent) => void;

  // Child components
  private profileSelector: ProfileSelectorUI | null = null;
  private promptTextareaEl: HTMLTextAreaElement | null = null;

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
    this.viewedProvider = model.provider;
    this.refs.profileSettingsPopoverEl.removeClass("lmsa-hidden");
    this.renderContent();
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

  private renderContent(): void {
    const model = this.callbacks.getActiveModel();
    if (!model) return;
    const provider = this.viewedProvider ?? model.provider;
    this.viewedProvider = provider;

    const el = this.refs.profileSettingsPopoverEl;
    el.empty();
    this.profileSelector = null;
    this.promptTextareaEl = null;

    const descriptor = this.callbacks.getProviderDescriptor(provider);
    const profile = this.callbacks.getActiveProfile(provider);

    const layout = el.createDiv({ cls: "lmsa-profile-popover-layout" });
    this.renderRail(layout.createDiv({ cls: "lmsa-provider-rail" }), provider);
    const contentEl = layout.createDiv({ cls: "lmsa-profile-popover-content" });

    const title = contentEl.createDiv({
      cls: "lmsa-profile-popover-title",
      text: "Model parameters",
    });
    title.createEl("span", {
      cls: "lmsa-profile-popover-subtitle",
      text:
        provider === model.provider
          ? model.name
          : `${descriptor.label} (not the active model)`,
    });

    // Profile selector
    this.profileSelector = new ProfileSelectorUI(contentEl, {
      getProfilesForProvider: this.callbacks.getProfilesForProvider,
      onProfileSelect: this.callbacks.onProfileSelect,
      onProfileCreate: this.callbacks.onProfileCreate,
      onProfileDelete: this.callbacks.onProfileDelete,
    });
    this.profileSelector.setRerenderCallback(() => this.renderContent());
    this.profileSelector.render(provider, profile);

    const body = contentEl.createDiv({ cls: "lmsa-profile-popover-body" });

    // Default profile hint
    if (profile.isDefault) {
      body.createDiv({
        cls: "lmsa-profile-popover-hint",
        text: "Create a profile to customize parameters",
      });
    }

    // Sampling params section
    this.renderSamplingSection(body, descriptor.supportedParams, profile);

    // Reasoning, remembered per model rather than per profile, so it only
    // renders while viewing the active model's provider (there is no model to
    // key the entry on for the others) and is never profile-gated.
    if (provider === model.provider) {
      this.renderModelReasoningSection(body);
    }

    // Anthropic cache section
    if (provider === "anthropic") {
      new CacheSettingsControl(body, {
        settings: profile.anthropicCacheSettings,
        onChange: (settings) => this.emitProfileUpdate({ anthropicCacheSettings: settings }),
      });
    }

    // Disable built-in system prompts (all providers)
    this.buildDisableBuiltinPromptsSection(body, profile);

    // Disable all controls when on default profile
    this.setControlsDisabled(profile.isDefault);
  }

  // ---------------------------------------------------------------------------
  // Provider rail
  // ---------------------------------------------------------------------------

  /**
   * Same fixed shape as the model dropdown's rail minus favorites: enabled
   * providers in PROVIDER_OPTIONS order, then, behind a divider, the disabled
   * ones grayed out and non-interactive.
   */
  private renderRail(railEl: HTMLElement, active: ProviderOption): void {
    const enabled = PROVIDER_OPTIONS.filter((p) => this.callbacks.isProviderEnabled(p));
    const disabled = PROVIDER_OPTIONS.filter((p) => !this.callbacks.isProviderEnabled(p));
    renderProviderRail(
      railEl,
      [
        enabled.map((provider) => providerRailEntry(provider, true)),
        disabled.map((provider) => providerRailEntry(provider, false)),
      ],
      active,
      (provider) => {
        // A pending system-prompt edit belongs to the provider being left.
        this.flushPendingSave();
        this.viewedProvider = provider;
        this.renderContent();
      }
    );
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

    if (supportedParams.temperature) {
      new TemperatureControl(paramsBody, {
        value: profile.temperature,
        onChange: (v) => this.emitProfileUpdate({ temperature: v }),
      });
    }

    if (supportedParams.maxTokens) {
      new NumberParamControl(paramsBody, {
        label: "Max tokens",
        min: 1,
        max: 32768,
        step: 1,
        placeholder: "e.g. 2000",
        value: profile.maxTokens,
        onChange: (v) => this.emitProfileUpdate({ maxTokens: v }),
      });
    }

    if (supportedParams.topP) {
      new SliderParamControl(paramsBody, {
        label: "Top P",
        min: 0,
        max: 1,
        step: 0.05,
        decimals: 2,
        value: profile.topP,
        onChange: (v) => this.emitProfileUpdate({ topP: v }),
      });
    }

    if (supportedParams.topK) {
      new NumberParamControl(paramsBody, {
        label: "Top K",
        min: 1,
        max: 500,
        step: 1,
        placeholder: "e.g. 40",
        value: profile.topK,
        onChange: (v) => this.emitProfileUpdate({ topK: v }),
      });
    }

    if (supportedParams.minP) {
      new SliderParamControl(paramsBody, {
        label: "Min P",
        min: 0,
        max: 1,
        step: 0.01,
        decimals: 2,
        value: profile.minP,
        onChange: (v) => this.emitProfileUpdate({ minP: v }),
      });
    }

    if (supportedParams.repeatPenalty) {
      new SliderParamControl(paramsBody, {
        label: "Repeat penalty",
        min: 0.5,
        max: 2.0,
        step: 0.05,
        decimals: 2,
        value: profile.repeatPenalty,
        onChange: (v) => this.emitProfileUpdate({ repeatPenalty: v }),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Per-model reasoning
  // ---------------------------------------------------------------------------

  /**
   * The popover-side reasoning control. Reads/writes the same per-model entry
   * as the composer pill (they can never disagree) and stays enabled on the
   * default profile, it is not a profile parameter.
   */
  private renderModelReasoningSection(body: HTMLElement): void {
    const levels = this.callbacks.getModelReasoningLevels();
    if (levels.length === 0) return;

    const section = body.createDiv({
      cls: "lmsa-profile-popover-section lmsa-model-reasoning-section",
    });
    section.createEl("div", {
      cls: "lmsa-profile-popover-section-title",
      text: "Reasoning",
    });
    const sectionBody = section.createDiv({ cls: "lmsa-params-body" });
    new ReasoningControl(sectionBody, {
      value: this.callbacks.getModelReasoning(),
      levels,
      onChange: (v) => void this.callbacks.onModelReasoningChange(v),
    });
    section.createEl("span", {
      cls: "lmsa-profile-popover-hint",
      text: "Remembered per model, off means the model default.",
    });
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
    });

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
  // Disable built-in system prompts
  // ---------------------------------------------------------------------------

  private buildDisableBuiltinPromptsSection(container: HTMLElement, profile: ProviderProfile): void {
    const section = container.createDiv({ cls: "lmsa-profile-popover-section" });

    const toggleRow = section.createDiv({ cls: "lmsa-params-toggle-row" });
    const toggle = toggleRow.createEl("input", {
      cls: "lmsa-params-toggle",
      attr: { type: "checkbox" },
    });
    toggle.checked = profile.disableBuiltinSystemPrompts;
    toggleRow.createEl("label", {
      cls: "lmsa-params-label",
      text: "Disable built-in system prompts",
    });

    section.createEl("span", {
      cls: "lmsa-disable-prompts-warning",
      text: "Edit, agentic, and tool features may not work correctly.",
    });

    toggle.addEventListener("change", () => {
      this.emitProfileUpdate({ disableBuiltinSystemPrompts: toggle.checked });
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private emitProfileUpdate(patch: Partial<ProviderProfile>): void {
    const provider = this.viewedProvider;
    if (!provider) return;
    const profile = this.callbacks.getActiveProfile(provider);
    if (profile.isDefault) return;
    void this.callbacks.onProfileUpdate(profile.id, patch);
  }

  private setControlsDisabled(disabled: boolean): void {
    const el = this.refs.profileSettingsPopoverEl;
    const inputs = el.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      ".lmsa-params-body input, .lmsa-params-body select, .lmsa-params-body textarea, " +
      ".lmsa-profile-popover-section input, .lmsa-profile-popover-section select",
    );
    for (const input of Array.from(inputs)) {
      // Reasoning is per model, not a profile parameter; it stays editable on
      // the default profile (only its own dropdown-follows-toggle state applies).
      if (input.closest(".lmsa-model-reasoning-section")) continue;
      input.disabled = disabled;
    }
    el.toggleClass("is-default-profile", disabled);
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

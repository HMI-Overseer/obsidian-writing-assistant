import type {
  CompletionModel,
  ProviderOption,
  ProviderProfile,
} from "../../shared/types";
import type { ProviderDescriptor, SamplingParamSupport } from "../../providers/types";
import type { ChatLayoutRefs } from "../types";
import { ProfileSelectorUI } from "./ProfileSelectorUI";
import {
  TemperatureControl,
  SliderParamControl,
  NumberParamControl,
  ReasoningControl,
  CacheSettingsControl,
} from "./controls";

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

export class ProfileSettingsPopover {
  private popoverOpen = false;
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
    this.profileSelector = null;
    this.promptTextareaEl = null;

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
    this.profileSelector = new ProfileSelectorUI(el, {
      getProfilesForProvider: this.callbacks.getProfilesForProvider,
      onProfileSelect: this.callbacks.onProfileSelect,
      onProfileCreate: this.callbacks.onProfileCreate,
      onProfileDelete: this.callbacks.onProfileDelete,
    });
    this.profileSelector.setRerenderCallback(() => {
      const m = this.callbacks.getActiveModel();
      if (m) this.renderContent(m);
    });
    this.profileSelector.render(provider, profile);

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
      new CacheSettingsControl(body, {
        settings: profile.anthropicCacheSettings,
        onChange: (settings) => this.emitProfileUpdate({ anthropicCacheSettings: settings }),
      });
    }

    // Disable all controls when on default profile
    this.setControlsDisabled(profile.isDefault);
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

    if (supportedParams.reasoning) {
      new ReasoningControl(paramsBody, {
        value: profile.reasoning,
        onChange: (v) => this.emitProfileUpdate({ reasoning: v }),
      });
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

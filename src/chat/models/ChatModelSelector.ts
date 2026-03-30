import { LMStudioModelsService } from "../../api";
import type LMStudioWritingAssistant from "../../main";
import type { CompletionModel } from "../../shared/types";
import type { ChatLayoutRefs, ModelAvailabilityState } from "../types";
import { setIcon } from "obsidian";

const MODEL_SELECTOR_ATTENTION_DURATION_MS = 700;

type ChatModelSelectorOptions = {
  getActiveModel: () => CompletionModel | null;
  getActiveProfileId: () => string;
  getModels: () => CompletionModel[];
  onSelectModel: (model: CompletionModel) => Promise<void>;
};

export class ChatModelSelector {
  private modelDropdownOpen = false;
  private modelSelectorAttentionTimer: number | null = null;
  private isCheckingModelStatus = false;
  private knownModelAvailability = new Map<string, ModelAvailabilityState>();

  constructor(
    private readonly plugin: LMStudioWritingAssistant,
    private readonly refs: Pick<
      ChatLayoutRefs,
      | "modelSelectorBtn"
      | "modelSelectorLabelEl"
      | "modelSelectorStatusEl"
      | "modelSelectorChevronEl"
      | "modelDropdownEl"
    >,
    private readonly options: ChatModelSelectorOptions
  ) {
    this.refs.modelSelectorBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggle();
    });
  }

  syncActiveModel(): void {
    const activeModel = this.options.getActiveModel();

    if (!activeModel?.modelId) {
      this.knownModelAvailability.clear();
      this.setModelAvailabilityState("unknown");
      return;
    }

    this.setModelAvailabilityState(
      this.getModelAvailabilityStateForId(activeModel.modelId)
    );
  }

  isCheckingStatus(): boolean {
    return this.isCheckingModelStatus;
  }

  isOpen(): boolean {
    return this.modelDropdownOpen;
  }

  close(): void {
    this.refs.modelDropdownEl.style.display = "none";
    this.modelDropdownOpen = false;
    this.refs.modelSelectorBtn.removeClass("is-active");
    setIcon(this.refs.modelSelectorChevronEl, "chevron-down");
  }

  clearAttention(): void {
    if (this.modelSelectorAttentionTimer !== null) {
      window.clearTimeout(this.modelSelectorAttentionTimer);
      this.modelSelectorAttentionTimer = null;
    }

    this.refs.modelSelectorBtn.removeClass("is-attention");
  }

  retriggerAttention(): void {
    this.clearAttention();
    this.refs.modelSelectorBtn.removeClass("is-attention");
    void this.refs.modelSelectorBtn.offsetWidth;
    this.refs.modelSelectorBtn.addClass("is-attention");
    this.modelSelectorAttentionTimer = window.setTimeout(() => {
      this.modelSelectorAttentionTimer = null;
      this.refs.modelSelectorBtn.removeClass("is-attention");
    }, MODEL_SELECTOR_ATTENTION_DURATION_MS);
  }

  async refreshAvailability(
    forceRefresh = true
  ): Promise<ModelAvailabilityState> {
    const activeModel = this.options.getActiveModel();
    if (!activeModel?.modelId) {
      this.knownModelAvailability.clear();
      this.setModelAvailabilityState("unknown");
      return "unknown";
    }

    // Cloud providers are always assumed available — skip LM Studio discovery
    if (activeModel.provider !== "lmstudio") {
      this.setModelAvailabilityState("loaded");
      return "loaded";
    }

    this.isCheckingModelStatus = true;

    try {
      const lmSettings = this.plugin.settings.providerSettings.lmstudio;
      const modelsService = new LMStudioModelsService(
        lmSettings.baseUrl,
        lmSettings.bypassCors
      );
      const result = await modelsService.getCompletionCandidates({ forceRefresh });
      const states = new Map<string, ModelAvailabilityState>();

      for (const candidate of result.candidates) {
        states.set(
          candidate.targetModelId,
          candidate.isLoaded ? "loaded" : "unloaded"
        );
      }

      this.applyKnownModelAvailability(states);
      return this.getModelAvailabilityStateForId(activeModel.modelId);
    } catch {
      const states = new Map<string, ModelAvailabilityState>();
      for (const model of this.options.getModels()) {
        states.set(model.modelId, "unknown");
      }

      this.applyKnownModelAvailability(states);
      return "unknown";
    } finally {
      this.isCheckingModelStatus = false;
    }
  }

  destroy(): void {
    this.clearAttention();
  }

  private toggle(): void {
    if (this.modelDropdownOpen) {
      this.close();
      return;
    }

    this.open();
  }

  private open(): void {
    this.refs.modelDropdownEl.empty();
    this.refs.modelDropdownEl.style.display = "block";
    this.modelDropdownOpen = true;
    this.refs.modelSelectorBtn.addClass("is-active");
    setIcon(this.refs.modelSelectorChevronEl, "chevron-up");

    const loadingList = this.refs.modelDropdownEl.createDiv({
      cls: "lmsa-model-dropdown-list",
    });
    loadingList.createDiv({
      cls: "lmsa-model-dropdown-empty",
      text: "Loading models...",
    });

    void this.renderDropdownItems();
  }

  private getModelAvailabilityStateForId(
    modelId: string
  ): ModelAvailabilityState {
    return this.knownModelAvailability.get(modelId) ?? "unknown";
  }

  private applyKnownModelAvailability(
    states: Map<string, ModelAvailabilityState>
  ): void {
    this.knownModelAvailability = states;
    this.syncActiveModel();
  }

  private setModelAvailabilityState(state: ModelAvailabilityState): void {
    this.refs.modelSelectorStatusEl.removeClass(
      "is-loaded",
      "is-unloaded",
      "is-unknown",
      "is-hidden"
    );

    const activeModel = this.options.getActiveModel();
    if (!activeModel?.modelId) {
      this.refs.modelSelectorStatusEl.addClass("is-hidden");
      return;
    }

    this.refs.modelSelectorStatusEl.addClass(`is-${state}`);
  }

  private async renderDropdownItems(): Promise<void> {
    await this.refreshAvailability();
    if (!this.modelDropdownOpen) return;

    const models = this.options.getModels();
    const activeProfileId = this.options.getActiveProfileId();
    this.refs.modelDropdownEl.empty();

    const listEl = this.refs.modelDropdownEl.createDiv({
      cls: "lmsa-model-dropdown-list",
    });

    if (models.length === 0) {
      listEl.createDiv({
        cls: "lmsa-model-dropdown-empty",
        text: "No profiles configured. Add one in Settings.",
      });
      return;
    }

    for (const model of models) {
      const item = listEl.createDiv({
        cls: "lmsa-model-dropdown-item",
      });
      const checkSpan = item.createEl("span", {
        cls: "lmsa-model-dropdown-check",
      });
      if (model.id === activeProfileId) {
        item.addClass("is-active");
        setIcon(checkSpan, "check");
      }

      const copy = item.createDiv({ cls: "lmsa-model-dropdown-copy" });
      copy.createEl("span", {
        cls: "lmsa-model-dropdown-name",
        text: model.name,
      });

      const itemState = this.getModelAvailabilityStateForId(model.modelId);
      item.createEl("span", {
        cls: `lmsa-model-dropdown-state is-${itemState}`,
      });

      item.addEventListener("click", async (event) => {
        event.stopPropagation();
        await this.options.onSelectModel(model);
        this.close();
      });
    }
  }
}

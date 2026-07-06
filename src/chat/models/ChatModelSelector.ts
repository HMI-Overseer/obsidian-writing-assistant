import type WritingAssistantChat from "../../main";
import type { CompletionModel, ModelAvailabilityState } from "../../shared/types";
import type { ChatLayoutRefs } from "../types";
import { setIcon } from "obsidian";
import { ModelDropdownView, pluginModelDropdownDeps } from "./ModelDropdownView";

const MODEL_SELECTOR_ATTENTION_DURATION_MS = 700;

type ChatModelSelectorOptions = {
  getActiveModel: () => CompletionModel | null;
  getActiveProfileId: () => string;
  /** Composed selectable list (enabled providers' catalogs + live discovery). */
  getModels: () => CompletionModel[];
  onSelectModel: (model: CompletionModel) => Promise<void>;
};

export class ChatModelSelector {
  private modelDropdownOpen = false;
  private modelSelectorAttentionTimer: number | null = null;
  private isCheckingModelStatus = false;

  constructor(
    private readonly plugin: WritingAssistantChat,
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
    // Interior clicks (search field, rail, star toggles) mutate selector state
    // without selecting; none of them may trip ChatView's document click-away.
    this.refs.modelDropdownEl.addEventListener("click", (event) => {
      event.stopPropagation();
    });
  }

  syncActiveModel(): void {
    const activeModel = this.options.getActiveModel();

    if (!activeModel?.modelId) {
      this.setModelAvailabilityState("unknown");
      return;
    }

    const { state } = this.plugin.services.modelAvailability.getAvailability(
      activeModel.modelId,
      activeModel.provider,
    );
    this.setModelAvailabilityState(state);
  }

  isCheckingStatus(): boolean {
    return this.isCheckingModelStatus;
  }

  isOpen(): boolean {
    return this.modelDropdownOpen;
  }

  close(): void {
    this.refs.modelDropdownEl.addClass("lmsa-hidden");
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
      this.setModelAvailabilityState("unknown");
      return "unknown";
    }

    const availability = this.plugin.services.modelAvailability;
    const info = availability.getAvailability(activeModel.modelId, activeModel.provider);

    if (info.state === "cloud") {
      this.setModelAvailabilityState("cloud");
      return "cloud";
    }

    this.isCheckingModelStatus = true;

    try {
      await availability.refreshLocalModels({ forceRefresh });
      const refreshed = availability.getAvailability(activeModel.modelId, activeModel.provider);
      this.setModelAvailabilityState(refreshed.state);
      return refreshed.state;
    } catch {
      this.setModelAvailabilityState("unknown");
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
    this.refs.modelDropdownEl.removeClass("lmsa-hidden");
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

    void this.renderDropdownContents();
  }

  private setModelAvailabilityState(state: ModelAvailabilityState): void {
    this.refs.modelSelectorStatusEl.removeClass(
      "is-loaded",
      "is-unloaded",
      "is-unknown",
      "is-cloud",
      "is-hidden"
    );

    const activeModel = this.options.getActiveModel();
    if (!activeModel?.modelId) {
      this.refs.modelSelectorStatusEl.addClass("is-hidden");
      return;
    }

    this.refs.modelSelectorStatusEl.addClass(`is-${state}`);
  }

  private async renderDropdownContents(): Promise<void> {
    await this.refreshAvailability();
    if (!this.modelDropdownOpen) return;

    const view = new ModelDropdownView<CompletionModel>(
      pluginModelDropdownDeps(this.plugin),
      this.refs.modelDropdownEl,
      {
        getModels: () => this.options.getModels(),
        getSelectedId: () => this.options.getActiveProfileId(),
        onSelect: (model) => {
          void this.selectAndClose(model);
        },
        // Keep the trigger's availability dot in step with a manual refresh.
        onAfterRefresh: () => this.syncActiveModel(),
      }
    );
    view.render();
  }

  private async selectAndClose(model: CompletionModel): Promise<void> {
    await this.options.onSelectModel(model);
    this.close();
  }
}

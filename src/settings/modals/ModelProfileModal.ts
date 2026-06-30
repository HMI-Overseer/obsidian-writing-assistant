import type { App } from "obsidian";
import { Modal, Notice } from "obsidian";
import { SettingItem } from "../ui";
import type WritingAssistantChat from "../../main";
import type { ModelCandidateResult, ModelDigest } from "../../api/types";
import type { ProviderOption } from "../../shared/types";
import { PROVIDER_DESCRIPTORS } from "../../providers/descriptors";

type BaseModel = { id: string; name: string; modelId: string; provider: ProviderOption };

export abstract class ModelProfileModal<T extends BaseModel> extends Modal {
  protected model: T;
  /** Candidates from model discovery, keyed by targetModelId. Populated async. */
  protected candidatesByModelId = new Map<string, ModelDigest>();

  constructor(
    app: App,
    protected plugin: WritingAssistantChat,
    source: T | null,
    private onSave: (model: T) => void,
    prefill?: Partial<T>,
    /**
     * When provided (and more than one), the modal renders a provider picker so
     * it can author a model end-to-end on its own. The settings tab omits this
     * (it selects the provider externally); the inline chat add path passes it.
     */
    private providerChoices?: ProviderOption[]
  ) {
    super(app);
    this.model = source
      ? { ...source, ...prefill }
      : this.createDefaultModel(prefill);
  }

  protected abstract createDefaultModel(prefill?: Partial<T>): T;
  protected abstract getDatalistId(): string;
  /**
   * Discover live model candidates for a provider. Unified across providers
   * (covers Claude Code too, which the old per-provider methods could not), so
   * it feeds both the hidden datalist and the inline discovery list.
   */
  protected abstract discoverCandidates(
    provider: ProviderOption,
    options: { forceRefresh: boolean }
  ): Promise<ModelCandidateResult>;
  protected abstract renderExtraFields(contentEl: HTMLElement): void;

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.addClass("lmsa-modal");
    contentEl.createEl("h2", {
      text: this.model.name ? `Edit: ${this.model.name}` : "Add Model",
    });

    if (this.providerChoices && this.providerChoices.length > 1) {
      const choices = this.providerChoices;
      new SettingItem(contentEl)
        .setName("Provider")
        .setDesc("Which provider serves this model.")
        .addDropdown((dropdown) => {
          for (const provider of choices) {
            dropdown.addOption(provider, PROVIDER_DESCRIPTORS[provider].label);
          }
          dropdown.setValue(this.model.provider);
          dropdown.onChange((value) => {
            this.model.provider = value as ProviderOption;
            // Re-render: model ID hints, discovery datalist, and extra fields
            // are all provider-dependent.
            this.contentEl.empty();
            void this.onOpen();
          });
        });
    }

    const datalistId = this.getDatalistId();
    const datalist = document.createElement("datalist");
    datalist.id = datalistId;
    contentEl.appendChild(datalist);

    new SettingItem(contentEl)
      .setName("Display name")
      .setDesc("A label for this reusable model profile.")
      .addText((text) =>
        text
          .setPlaceholder("My profile")
          .setValue(this.model.name)
          .onChange((value) => (this.model.name = value))
      );

    const modelIdDesc = this.model.provider === "anthropic"
      ? "The Anthropic model ID (e.g., claude-sonnet-4-20250514)."
      : this.model.provider === "openai"
        ? "The OpenAI model ID (e.g., gpt-4o)."
        : "The selected LM Studio model or variant this profile should target.";

    const modelIdPlaceholder = this.model.provider === "anthropic"
      ? "e.g. claude-sonnet-4-20250514"
      : this.model.provider === "openai"
        ? "e.g. gpt-4o"
        : "e.g. model-id";

    new SettingItem(contentEl)
      .setName("Model ID")
      .setDesc(modelIdDesc)
      .addText((text) => {
        text.inputEl.setAttribute("list", datalistId);
        text.inputEl.addClass("lmsa-input-full");
        text
          .setPlaceholder(modelIdPlaceholder)
          .setValue(this.model.modelId)
          .onChange((value) => {
            this.model.modelId = value;
            const candidate = this.candidatesByModelId.get(value);
            if (candidate) this.onCandidateMatched(candidate);
          });
      });

    this.renderExtraFields(contentEl);

    // Standalone (inline) mode gets a visible, clickable discovery list; the
    // settings-tab flow keeps just the hidden datalist autocomplete.
    if (this.providerChoices) {
      this.renderDiscoverySection(contentEl, datalist);
    } else {
      this.populateDatalist(datalist);
    }

    new SettingItem(contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText("Save")
          .setCta()
          .onClick(() => {
            if (!this.model.name.trim()) {
              new Notice("Please enter a display name.");
              return;
            }
            if (!this.model.modelId.trim()) {
              new Notice("Please enter a model ID.");
              return;
            }
            this.onSave(this.model);
            this.close();
          })
      );
  }

  private async loadCandidates(forceRefresh: boolean): Promise<ModelCandidateResult | null> {
    try {
      return await this.discoverCandidates(this.model.provider, { forceRefresh });
    } catch {
      // Provider may be offline or the key invalid.
      return null;
    }
  }

  private fillDatalist(datalist: HTMLDataListElement, result: ModelCandidateResult): void {
    for (const model of result.candidates) {
      this.candidatesByModelId.set(model.targetModelId, model);
      const option = document.createElement("option");
      option.value = model.targetModelId;
      option.label = `${model.displayName || model.targetModelId} (${model.targetModelId})`;
      datalist.appendChild(option);
    }
  }

  /** Hidden autocomplete only (settings-tab flow): fill the datalist, fail silently. */
  private populateDatalist(datalist: HTMLDataListElement): void {
    void (async () => {
      const result = await this.loadCandidates(false);
      if (result) this.fillDatalist(datalist, result);
    })();
  }

  /**
   * Visible, clickable discovery list for the inline add flow. Clicking a
   * candidate fills the form; the same fetch also feeds the datalist autocomplete.
   */
  private renderDiscoverySection(container: HTMLElement, datalist: HTMLDataListElement): void {
    const section = container.createDiv({ cls: "lmsa-modal-discovery" });
    const header = section.createDiv({ cls: "lmsa-modal-discovery-header" });
    header.createSpan({ cls: "lmsa-modal-discovery-title", text: "Available models" });
    const refreshBtn = header.createEl("button", {
      cls: "lmsa-ui-btn lmsa-ui-btn-secondary",
      text: "Refresh",
    });

    const listEl = section.createDiv({ cls: "lmsa-modal-discovery-list" });

    const load = async (forceRefresh: boolean): Promise<void> => {
      refreshBtn.disabled = true;
      listEl.empty();
      listEl.createEl("p", { cls: "lmsa-empty-state", text: "Loading models…" });

      const result = await this.loadCandidates(forceRefresh);
      refreshBtn.disabled = false;

      if (!result) {
        listEl.empty();
        listEl.createEl("p", {
          cls: "lmsa-empty-state",
          text: "Could not load models. Check the provider connection or API key, then refresh. You can also enter a model ID above manually.",
        });
        return;
      }

      this.fillDatalist(datalist, result);
      this.renderCandidateRows(listEl, result.candidates);
    };

    refreshBtn.addEventListener("click", () => void load(true));
    void load(false);
  }

  private renderCandidateRows(listEl: HTMLElement, candidates: ModelDigest[]): void {
    listEl.empty();

    if (candidates.length === 0) {
      listEl.createEl("p", {
        cls: "lmsa-empty-state",
        text: "No models reported. Enter a model ID above instead.",
      });
      return;
    }

    for (const candidate of candidates) {
      const row = listEl.createDiv({ cls: "lmsa-modal-discovery-row" });
      const rowHeader = row.createDiv({ cls: "lmsa-modal-discovery-row-header" });

      if (candidate.isLoaded !== undefined) {
        rowHeader.createSpan({
          cls: `lmsa-model-state-badge ${candidate.isLoaded ? "is-loaded" : "is-unloaded"}`,
          text: candidate.isLoaded ? "Loaded" : "Not loaded",
        });
      }
      rowHeader.createSpan({
        cls: "lmsa-item-name",
        text: candidate.displayName || candidate.targetModelId,
      });

      row.createSpan({ cls: "lmsa-item-sub", text: candidate.targetModelId });
      const meta = this.formatCandidateMeta(candidate);
      if (meta) row.createSpan({ cls: "lmsa-item-meta", text: meta });

      row.addEventListener("click", () => this.applyCandidate(candidate));
    }
  }

  private applyCandidate(candidate: ModelDigest): void {
    this.model.modelId = candidate.targetModelId;
    if (!this.model.name.trim()) {
      this.model.name = candidate.displayName || candidate.targetModelId;
    }
    this.onCandidateMatched(candidate);
    // Re-render so the filled fields (and any provider-specific extras) refresh.
    this.contentEl.empty();
    void this.onOpen();
  }

  private formatCandidateMeta(candidate: ModelDigest): string {
    if (candidate.summary) return candidate.summary;
    const ctx = candidate.activeContextLength ?? candidate.maxContextLength;
    if (!ctx || ctx <= 0) return "";
    if (ctx >= 1_000_000) {
      return `${(ctx / 1_000_000).toFixed(ctx % 1_000_000 === 0 ? 0 : 1)}M context tokens`;
    }
    if (ctx >= 1_000) return `${Math.round(ctx / 1_000).toLocaleString()}K context tokens`;
    return `${ctx.toLocaleString()} context tokens`;
  }

  /** Called when the user's model ID input matches a discovered candidate. Override to auto-fill fields. */
  protected onCandidateMatched(_candidate: ModelDigest): void {
    // No-op by default. Subclasses can override.
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

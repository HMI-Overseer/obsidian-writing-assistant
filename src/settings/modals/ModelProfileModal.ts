import type { App } from "obsidian";
import { Modal, Notice } from "obsidian";
import { SettingItem } from "../ui";
import type WritingAssistantChat from "../../main";
import type { LMStudioModelsService } from "../../api";
import type { AnthropicModelsService } from "../../api/AnthropicModelsService";
import type { ModelCandidateResult, ModelDigest } from "../../api/types";
import type { ProviderOption } from "../../shared/types";

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
    prefill?: Partial<T>
  ) {
    super(app);
    this.model = source
      ? { ...source, ...prefill }
      : this.createDefaultModel(prefill);
  }

  protected abstract createDefaultModel(prefill?: Partial<T>): T;
  protected abstract getDatalistId(): string;
  protected abstract getLMStudioCandidates(
    service: LMStudioModelsService
  ): Promise<ModelCandidateResult>;
  protected abstract getAnthropicCandidates(
    service: AnthropicModelsService
  ): Promise<ModelCandidateResult>;
  protected abstract renderExtraFields(contentEl: HTMLElement): void;

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.addClass("lmsa-modal");
    contentEl.createEl("h2", {
      text: this.model.name ? `Edit: ${this.model.name}` : "Add Model",
    });

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

    this.populateDatalist(datalist);
    this.renderExtraFields(contentEl);

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

  private populateDatalist(datalist: HTMLDataListElement): void {
    const fillOptions = (result: ModelCandidateResult) => {
      for (const model of result.candidates) {
        this.candidatesByModelId.set(model.targetModelId, model);
        const option = document.createElement("option");
        option.value = model.targetModelId;
        option.label = `${model.displayName || model.targetModelId} (${model.targetModelId})`;
        datalist.appendChild(option);
      }
    };

    void (async () => {
      try {
        if (this.model.provider === "lmstudio") {
          const service = this.plugin.modelAvailability.getLMStudioService();
          fillOptions(await this.getLMStudioCandidates(service));
        } else if (this.model.provider === "anthropic") {
          const apiKey = this.plugin.settings.providerSettings.anthropic.apiKey;
          if (!apiKey) return;
          const service = this.plugin.modelAvailability.getAnthropicService();
          fillOptions(await this.getAnthropicCandidates(service));
        }
      } catch {
        /* Provider may be offline or key invalid — fail silently for autocomplete. */
      }
    })();
  }

  /** Called when the user's model ID input matches a discovered candidate. Override to auto-fill fields. */
  protected onCandidateMatched(_candidate: ModelDigest): void {
    // No-op by default. Subclasses can override.
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

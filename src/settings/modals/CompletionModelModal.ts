import { SettingItem } from "../ui";
import type { LMStudioModelsService } from "../../api";
import type { AnthropicModelsService } from "../../api/AnthropicModelsService";
import type { ModelCandidateResult } from "../../api/types";
import type { CompletionModel, CacheTtl } from "../../shared/types";
import { generateId } from "../../utils";
import { ModelProfileModal } from "./ModelProfileModal";

export class CompletionModelModal extends ModelProfileModal<CompletionModel> {
  protected createDefaultModel(prefill?: Partial<CompletionModel>): CompletionModel {
    return {
      id: generateId(),
      name: prefill?.name ?? "",
      modelId: prefill?.modelId ?? "",
      provider: prefill?.provider ?? "lmstudio",
      ...(prefill?.contextWindowSize && { contextWindowSize: prefill.contextWindowSize }),
      ...(prefill?.anthropicCacheSettings && { anthropicCacheSettings: prefill.anthropicCacheSettings }),
    };
  }

  protected getDatalistId(): string {
    return "lmsa-completion-models-list";
  }

  protected getLMStudioCandidates(
    service: LMStudioModelsService
  ): Promise<ModelCandidateResult> {
    return service.getCompletionCandidates();
  }

  protected getAnthropicCandidates(
    service: AnthropicModelsService
  ): Promise<ModelCandidateResult> {
    return service.getCompletionCandidates();
  }

  protected renderExtraFields(contentEl: HTMLElement): void {
    new SettingItem(contentEl)
      .setName("Context window (tokens)")
      .setDesc("Maximum context length for this model. Auto-filled from discovery, or set manually.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.style.width = "100%";
        text
          .setPlaceholder("e.g. 128000")
          .setValue(this.model.contextWindowSize ? String(this.model.contextWindowSize) : "")
          .onChange((value) => {
            const parsed = parseInt(value, 10);
            if (parsed > 0) {
              this.model.contextWindowSize = parsed;
            } else {
              delete this.model.contextWindowSize;
            }
          });
      });

    if (this.model.provider === "anthropic") {
      new SettingItem(contentEl)
        .setName("Prompt caching")
        .setDesc(
          "Cache the system prompt and conversation prefix to reduce cost on repeated requests."
        )
        .addToggle((toggle) => {
          toggle
            .setValue(this.model.anthropicCacheSettings?.enabled ?? false)
            .onChange((value) => {
              if (!this.model.anthropicCacheSettings) {
                this.model.anthropicCacheSettings = { enabled: false, ttl: "default" };
              }
              this.model.anthropicCacheSettings.enabled = value;
            });
        });

      new SettingItem(contentEl)
        .setName("Cache TTL")
        .setDesc(
          "5 min is default. Extended (1 hour) costs 2x the cache write price but reduces read costs over longer sessions."
        )
        .addDropdown((dropdown) => {
          dropdown
            .addOption("default", "5 minutes (default)")
            .addOption("1h", "1 hour (extended)")
            .setValue(this.model.anthropicCacheSettings?.ttl ?? "default")
            .onChange((value) => {
              if (!this.model.anthropicCacheSettings) {
                this.model.anthropicCacheSettings = { enabled: false, ttl: "default" };
              }
              this.model.anthropicCacheSettings.ttl = value as CacheTtl;
            });
        });
    }
  }
}

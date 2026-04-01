import type { ConversationMessage } from "../shared/types";
import type { DocumentContext } from "../shared/chatRequest";
import { estimateTokenCount } from "../shared/tokenEstimation";
import { CONTEXT_WARNING_THRESHOLD, CONTEXT_DANGER_THRESHOLD } from "../constants";

const DEBOUNCE_MS = 150;

export interface ContextInputs {
  systemPrompt: string;
  documentContext: DocumentContext | null;
  messages: ConversationMessage[];
  draft: string;
  contextWindowSize: number | undefined;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export class ContextCapacityUpdater {
  /** Correction ratio learned from real API token counts. */
  private correctionRatio = 1.0;
  private debounceTimer: number | null = null;

  constructor(private readonly capacityEl: HTMLElement) {}

  /**
   * Schedule a debounced recalculation.
   * Use for high-frequency events like typing or active leaf changes.
   */
  scheduleUpdate(inputs: ContextInputs): void {
    this.clearPendingUpdate();
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      this.recalculate(inputs);
    }, DEBOUNCE_MS);
  }

  /**
   * Immediately recalculate — no debounce.
   * Use after discrete state changes (message send/receive/edit/delete, model change).
   */
  immediateUpdate(inputs: ContextInputs): void {
    this.clearPendingUpdate();
    this.recalculate(inputs);
  }

  /**
   * After an API response, calibrate the correction ratio so future
   * estimates are closer to the real token count.
   */
  calibrate(estimatedTokens: number, actualTokens: number): void {
    if (estimatedTokens > 0 && actualTokens > 0) {
      this.correctionRatio = actualTokens / estimatedTokens;
    }
  }

  /** Reset correction ratio (e.g., on model change — different tokenizer). */
  resetCalibration(): void {
    this.correctionRatio = 1.0;
  }

  destroy(): void {
    this.clearPendingUpdate();
  }

  private clearPendingUpdate(): void {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private recalculate(inputs: ContextInputs): void {
    const { systemPrompt, documentContext, messages, draft, contextWindowSize } = inputs;

    if (!contextWindowSize) {
      this.capacityEl.addClass("lmsa-hidden");
      return;
    }

    const chatTurns = messages
      .filter((m) => !m.isError)
      .map((m) => ({ role: m.role, content: m.content }));

    const rawEstimate = estimateTokenCount(
      { systemPrompt, documentContext, messages: chatTurns },
      draft
    );
    const correctedEstimate = Math.round(rawEstimate * this.correctionRatio);

    const ratio = correctedEstimate / contextWindowSize;
    const percent = Math.min(Math.round(ratio * 100), 100);

    this.capacityEl.removeClass("lmsa-hidden", "is-warning", "is-danger");
    if (ratio >= CONTEXT_DANGER_THRESHOLD) {
      this.capacityEl.addClass("is-danger");
    } else if (ratio >= CONTEXT_WARNING_THRESHOLD) {
      this.capacityEl.addClass("is-warning");
    }

    const fillEl = this.capacityEl.querySelector(
      ".lmsa-context-capacity-fill"
    ) as HTMLElement | null;
    if (fillEl) {
      fillEl.style.width = `${percent}%`;
    }

    const labelEl = this.capacityEl.querySelector(
      ".lmsa-context-capacity-label"
    ) as HTMLElement | null;
    if (labelEl) {
      labelEl.setText(
        `~${formatTokens(correctedEstimate)} / ${formatTokens(contextWindowSize)} tokens (${percent}%)`
      );
    }
  }
}

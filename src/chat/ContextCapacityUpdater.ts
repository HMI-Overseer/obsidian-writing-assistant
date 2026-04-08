import type { ConversationMessage } from "../shared/types";
import type { DocumentContext } from "../shared/chatRequest";
import { estimateTokenCount } from "../shared/tokenEstimation";
import { sumConversationUsage } from "./usageSummary";
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

const RING_CIRCUMFERENCE = 2 * Math.PI * 12;

export class ContextCapacityUpdater {
  /** Correction ratio learned from real API token counts. */
  private correctionRatio = 1.0;
  private debounceTimer: number | null = null;

  private readonly fillCircle: SVGCircleElement | null;
  private readonly tooltipEl: HTMLElement;
  private readonly tooltipContextEl: HTMLElement;
  private readonly tooltipUsageEl: HTMLElement;

  private readonly onEnter = (): void => this.positionTooltip();
  private readonly onLeave = (): void => this.tooltipEl.removeClass("is-visible");

  constructor(private readonly capacityEl: HTMLElement) {
    this.fillCircle = capacityEl.querySelector(".lmsa-context-ring-fill");

    this.tooltipEl = document.body.createDiv({ cls: "lmsa-context-ring-tooltip" });
    this.tooltipContextEl = this.tooltipEl.createEl("span", { cls: "lmsa-context-ring-tooltip-context" });
    this.tooltipUsageEl = this.tooltipEl.createEl("span", { cls: "lmsa-context-ring-tooltip-usage lmsa-hidden" });

    capacityEl.addEventListener("mouseenter", this.onEnter);
    capacityEl.addEventListener("mouseleave", this.onLeave);
  }

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
    this.capacityEl.removeEventListener("mouseenter", this.onEnter);
    this.capacityEl.removeEventListener("mouseleave", this.onLeave);
    this.tooltipEl.remove();
  }

  private clearPendingUpdate(): void {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /** Update the tooltip's usage line from conversation messages. */
  refreshUsage(messages: ConversationMessage[]): void {
    if (!this.tooltipUsageEl) return;

    const totals = sumConversationUsage(messages);
    if (!totals.hasUsage) {
      this.tooltipUsageEl.addClass("lmsa-hidden");
      return;
    }

    const totalTokens = totals.totalInputTokens + totals.totalOutputTokens;
    const tokenText = totalTokens >= 1_000
      ? `${(totalTokens / 1_000).toFixed(1)}k tokens`
      : `${totalTokens} tokens`;

    const parts: string[] = [];
    if (totals.totalCost > 0) {
      const costStr = totals.totalCost < 0.01
        ? `$${totals.totalCost.toFixed(4)}`
        : totals.totalCost < 1
          ? `$${totals.totalCost.toFixed(3)}`
          : `$${totals.totalCost.toFixed(2)}`;
      parts.push(costStr);
    }
    parts.push(tokenText);

    this.tooltipUsageEl.setText(parts.join(" \u00b7 "));
    this.tooltipUsageEl.removeClass("lmsa-hidden");
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

    if (this.fillCircle) {
      const offset = RING_CIRCUMFERENCE * (1 - ratio);
      this.fillCircle.setAttribute("stroke-dashoffset", String(Math.max(offset, 0)));
    }

    if (this.tooltipContextEl) {
      this.tooltipContextEl.setText(
        `Context: ~${formatTokens(correctedEstimate)} / ${formatTokens(contextWindowSize)} (${percent}%)`
      );
    }

    this.refreshUsage(messages);
  }

  private positionTooltip(): void {
    if (!this.tooltipEl) return;
    const rect = this.capacityEl.getBoundingClientRect();
    const gap = 6;

    this.tooltipEl.setCssStyles({
      top: `${rect.top - gap}px`,
      left: `${rect.left + rect.width / 2}px`,
    });
    this.tooltipEl.addClass("is-visible");
  }
}

import { setIcon } from "obsidian";
import type { AgenticStep } from "../../shared/types";

const TOOL_ICONS: Record<string, string> = {
  semantic_search: "search",
  read_file: "file-text",
  list_directory: "folder",
  directory_tree: "folder-tree",
  search_files: "file-search",
  get_document_outline: "list",
  get_line_range: "scan-line",
  think: "brain",
};

const TOOL_LABELS: Record<string, string> = {
  semantic_search: "Searched vault",
  read_file: "Read note",
  list_directory: "Listed folder",
  directory_tree: "Explored tree",
  search_files: "Searched files",
  get_document_outline: "Read document outline",
  get_line_range: "Inspected",
  think: "Thought",
};

/**
 * A live-updating timeline of agentic tool calls and reasoning steps.
 *
 * Created before the response bubble during streaming. Steps are added one by
 * one as the tool loop progresses. Stored steps are re-rendered statically
 * when loading historical messages.
 */
export class AgenticTimeline {
  private readonly steps: AgenticStep[] = [];
  private readonly summaryLabelEl: HTMLElement;
  private readonly listEl: HTMLElement;

  // Live-streaming reasoning state for the current round.
  private liveReasoningText = "";
  private liveReasoningEl: HTMLElement | null = null;
  private liveReasoningNameEl: HTMLElement | null = null;

  constructor(private readonly containerEl: HTMLElement) {
    const detailsEl = containerEl.createEl("details", {
      cls: "lmsa-agentic-timeline",
    });
    detailsEl.open = true;

    const summaryEl = detailsEl.createEl("summary", {
      cls: "lmsa-agentic-timeline-summary",
    });
    const iconEl = summaryEl.createSpan({ cls: "lmsa-agentic-timeline-summary-icon" });
    setIcon(iconEl, "hammer");
    this.summaryLabelEl = summaryEl.createSpan({
      cls: "lmsa-agentic-timeline-summary-label",
      text: "Thinking…",
    });

    this.listEl = detailsEl.createDiv({ cls: "lmsa-agentic-timeline-list" });
  }

  addStep(step: AgenticStep): void {
    this.steps.push(step);
    this.renderStep(step);
    this.updateSummary();
  }

  /**
   * Append a text delta to the live reasoning entry for the current round.
   * Creates the entry on first call; updates its display on subsequent calls.
   */
  addReasoningDelta(delta: string): void {
    this.liveReasoningText += delta;
    if (!this.liveReasoningEl) {
      this.initLiveReasoning();
    }
    const text = this.liveReasoningText;
    if (this.liveReasoningNameEl) {
      this.liveReasoningNameEl.textContent =
        text.length > 120 ? text.slice(0, 120) + "…" : text;
    }
  }

  /**
   * Commit the live reasoning entry as a permanent step (model called tools after this text).
   * Stores the step for persistence and releases the live references so the next round starts fresh.
   */
  commitLiveReasoning(round: number): void {
    const text = this.liveReasoningText.trim();
    if (!text) {
      this.discardLiveReasoning();
      return;
    }
    this.steps.push({ type: "reasoning", round, text });
    // The live DOM element stays in place as the committed step.
    this.liveReasoningEl = null;
    this.liveReasoningNameEl = null;
    this.liveReasoningText = "";
  }

  /**
   * Remove the live reasoning entry without recording it (model produced a final text response).
   */
  discardLiveReasoning(): void {
    this.liveReasoningEl?.remove();
    this.liveReasoningEl = null;
    this.liveReasoningNameEl = null;
    this.liveReasoningText = "";
  }

  getSteps(): AgenticStep[] {
    return [...this.steps];
  }

  /** Re-render all steps from stored data (e.g. loading a historical message). */
  static render(containerEl: HTMLElement, steps: AgenticStep[]): void {
    const timeline = new AgenticTimeline(containerEl);
    for (const step of steps) {
      timeline.addStep(step);
    }
  }

  private initLiveReasoning(): void {
    const stepEl = this.listEl.createDiv({
      cls: "lmsa-agentic-timeline-step lmsa-agentic-timeline-step--reasoning",
    });
    const dotEl = stepEl.createDiv({ cls: "lmsa-agentic-timeline-dot" });
    setIcon(dotEl, "message-square");
    const bodyEl = stepEl.createDiv({ cls: "lmsa-agentic-timeline-step-body" });
    this.liveReasoningNameEl = bodyEl.createSpan({
      cls: "lmsa-agentic-timeline-step-name",
      text: "…",
    });
    this.liveReasoningEl = stepEl;
  }

  private updateSummary(): void {
    const toolCount = this.steps.filter(
      (s) => s.type === "tool_call" && s.toolName !== "think",
    ).length;
    this.summaryLabelEl.textContent =
      toolCount === 0 ? "Thinking…" :
      toolCount === 1 ? "1 tool call" :
      `${toolCount} tool calls`;
  }

  private renderStep(step: AgenticStep): void {
    const stepEl = this.listEl.createDiv({
      cls: `lmsa-agentic-timeline-step lmsa-agentic-timeline-step--${step.type}`,
    });

    const dotEl = stepEl.createDiv({ cls: "lmsa-agentic-timeline-dot" });
    setIcon(dotEl, step.type === "tool_call"
      ? (TOOL_ICONS[step.toolName ?? ""] ?? "wrench")
      : "message-square");

    const bodyEl = stepEl.createDiv({ cls: "lmsa-agentic-timeline-step-body" });

    if (step.type === "tool_call") {
      const label = TOOL_LABELS[step.toolName ?? ""] ?? (step.toolName ?? "Tool call");
      bodyEl.createSpan({ cls: "lmsa-agentic-timeline-step-name", text: label });
      if (step.toolInput) {
        bodyEl.createSpan({ cls: "lmsa-agentic-timeline-step-detail", text: step.toolInput });
      }
    } else if (step.text) {
      const truncated = step.text.length > 120 ? step.text.slice(0, 120) + "…" : step.text;
      bodyEl.createSpan({ cls: "lmsa-agentic-timeline-step-name", text: truncated });
    }
  }
}

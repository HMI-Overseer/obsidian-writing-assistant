import { setIcon } from "obsidian";
import type { AgenticStep } from "../../shared/types";
import type { VaultOpDisposition } from "../../vault-ops/disposition";
import { TOOL_ICONS, TOOL_LABELS, isMutatingTool } from "../../tools/metadata";
import { captureStepFields } from "../../tools/resultDigest";

/**
 * A live-updating timeline of agentic tool calls and reasoning steps.
 *
 * Created before the response bubble during streaming. Steps are added one by
 * one as the tool loop progresses. Stored steps are re-rendered statically
 * when loading historical messages.
 *
 * Tool-call steps that carry a `toolCallId` tag their element with
 * `data-tool-call-id`, so a later pass can find a step by id and decorate it,
 * e.g. the vault-op review attaching inline approve/decline to write steps
 * (see `vaultReviewTimeline.ts`). The timeline itself stays domain-agnostic.
 */
export class AgenticTimeline {
  private readonly steps: AgenticStep[] = [];
  private readonly detailsEl: HTMLDetailsElement;
  private readonly summaryLabelEl: HTMLElement;
  private readonly listEl: HTMLElement;

  // Live-streaming reasoning state for the current round.
  private liveReasoningText = "";
  private liveReasoningEl: HTMLElement | null = null;
  private liveReasoningNameEl: HTMLElement | null = null;

  // Pending tool call elements waiting to be claimed by addStep (FIFO per tool name).
  private readonly pendingToolCallEls = new Map<string, Array<{ stepEl: HTMLElement; detailEl: HTMLElement }>>();

  constructor(private readonly containerEl: HTMLElement) {
    const detailsEl = containerEl.createEl("details", {
      cls: "lmsa-agentic-timeline",
    });
    detailsEl.open = true;
    this.detailsEl = detailsEl;

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

  /**
   * Show a pending placeholder for a tool call that has been identified during
   * streaming but hasn't executed yet. Claimed and finalized by `addStep()`.
   *
   * `toolCallId` is set when the caller already knows it (the Claude Code path mints
   * the id before the call runs). Tagging it on the placeholder lets the in-loop vault
   * review bind approve/decline to this exact step *while it is still pending*, without
   * it the review falls back to positional matching, which a preceding failed call (a
   * step with no op) can misalign into a stray synthetic row (vaultReviewTimeline.ts).
   */
  addPendingToolCall(toolName: string, toolCallId?: string): void {
    const stepEl = this.listEl.createDiv({
      cls: toolStepClasses(toolName, "lmsa-agentic-timeline-step--pending"),
    });
    // Tag the tool name so a later pass can bind to it positionally if its
    // tool-call id is missing (vault review fallback, see vaultReviewTimeline.ts).
    stepEl.dataset.toolName = toolName;
    if (toolCallId) stepEl.dataset.toolCallId = toolCallId;
    const dotEl = stepEl.createDiv({ cls: "lmsa-agentic-timeline-dot" });
    setIcon(dotEl, TOOL_ICONS[toolName] ?? "wrench");
    const bodyEl = stepEl.createDiv({ cls: "lmsa-agentic-timeline-step-body" });
    bodyEl.createSpan({
      cls: "lmsa-agentic-timeline-step-name",
      text: TOOL_LABELS[toolName] ?? toolName,
    });
    const detailEl = bodyEl.createSpan({ cls: "lmsa-agentic-timeline-step-detail", text: "…" });

    const queue = this.pendingToolCallEls.get(toolName) ?? [];
    queue.push({ stepEl, detailEl });
    this.pendingToolCallEls.set(toolName, queue);
  }

  addStep(step: AgenticStep): void {
    this.steps.push(step);

    // If a pending placeholder exists for this tool call, claim it instead of
    // creating a new element (FIFO: first pending matches first completed).
    if (step.type === "tool_call" && step.toolName) {
      const queue = this.pendingToolCallEls.get(step.toolName);
      if (queue && queue.length > 0) {
        // Prefer the placeholder already tagged with this id (the Claude Code path
        // tags it at `start`), so out-of-order completion can't claim the wrong row;
        // otherwise FIFO (the plugin path, whose placeholders carry no id yet).
        const claimIdx = selectClaimIndex(
          queue.map((p) => p.stepEl.dataset.toolCallId),
          step.toolCallId,
        );
        const [pending] = queue.splice(claimIdx, 1);
        if (!pending) { this.renderStep(step); this.updateSummary(); return; }
        const { stepEl, detailEl } = pending;
        if (queue.length === 0) this.pendingToolCallEls.delete(step.toolName);
        stepEl.classList.remove("lmsa-agentic-timeline-step--pending");
        if (step.toolCallId) stepEl.dataset.toolCallId = step.toolCallId;
        if (step.toolInput) {
          detailEl.textContent = step.toolInput;
        } else {
          detailEl.remove();
        }
        if (step.toolArgs) {
          this.renderExpandableArgs(stepEl, step.toolArgs);
        }
        if (step.isError) {
          this.decorateError(stepEl, step.errorContent ?? "");
        }
        this.updateSummary();
        return;
      }
    }

    this.renderStep(step);
    this.updateSummary();
  }

  /**
   * Attach a tool result to an already-rendered step after it resolves, the vault-op
   * and edit channels record their step *before* the user decides, so the error state
   * lands here. Updates the stored step (so {@link getSteps} persists it for history)
   * and the live DOM, in both directions: an error result decorates the step, a
   * non-error result strips any decoration so the two never drift.
   *
   * Also captures the phase-2 replay fields (disposition + bounded record) the
   * pre-resolution record could not hold, via the same {@link captureStepFields} the
   * read channel spreads at record time (cold-rebuild-fidelity §6 q6 / question 9).
   */
  setStepResult(
    toolCallId: string,
    result: { isError?: boolean; content: string; disposition?: VaultOpDisposition },
  ): void {
    const step = this.steps.find(
      (s) => s.type === "tool_call" && s.toolCallId === toolCallId,
    );
    if (step) {
      if (result.isError) {
        step.isError = true;
        step.errorContent = result.content;
      } else {
        delete step.isError;
        delete step.errorContent;
      }
      Object.assign(step, captureStepFields(step.toolName ?? "", step.toolArgs ?? {}, result));
    }
    const stepEl = this.listEl.querySelector<HTMLElement>(
      `[data-tool-call-id="${CSS.escape(toolCallId)}"]`,
    );
    if (!stepEl) return;
    if (result.isError) {
      this.decorateError(stepEl, result.content);
    } else {
      this.clearError(stepEl);
    }
  }

  /** Remove any error decoration (red class, "Failed" label, error block) from a step. */
  private clearError(stepEl: HTMLElement): void {
    stepEl.classList.remove("lmsa-agentic-timeline-step--error");
    const bodyEl =
      (stepEl.querySelector(".lmsa-agentic-timeline-step-body") as HTMLElement | null) ?? stepEl;
    bodyEl.querySelector(":scope > .lmsa-agentic-timeline-step-failed")?.remove();
    bodyEl
      .querySelector(":scope > .lmsa-agentic-timeline-step-expand > .lmsa-agentic-timeline-error")
      ?.remove();
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

  /**
   * Settle the timeline once the turn ends: swap the present-tense "Thinking…" summary for
   * a terminal label so a finished turn never reads as still in progress. A think-only turn
   * (no tool calls, so no pending approvals) also collapses; tool turns stay expanded since
   * they may carry pending review controls.
   */
  finalize(): void {
    // Sweep any pending placeholders that were announced during streaming but never
    // claimed by a recorded step, e.g. a mutation batch abandoned at the round cap or a
    // turn aborted mid-drain, so none linger forever as a "…" pending row.
    for (const [, queue] of this.pendingToolCallEls) {
      for (const { stepEl } of queue) stepEl.remove();
    }
    this.pendingToolCallEls.clear();

    const toolCount = this.steps.filter(
      (s) => s.type === "tool_call" && s.toolName !== "think",
    ).length;
    if (toolCount === 0) {
      this.summaryLabelEl.textContent = "Thought for a moment";
      this.detailsEl.open = false;
      return;
    }
    this.summaryLabelEl.textContent =
      toolCount === 1 ? "Used 1 tool" : `Used ${toolCount} tools`;
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
      cls:
        step.type === "tool_call"
          ? toolStepClasses(step.toolName)
          : "lmsa-agentic-timeline-step lmsa-agentic-timeline-step--reasoning",
    });
    if (step.toolCallId) stepEl.dataset.toolCallId = step.toolCallId;
    if (step.type === "tool_call" && step.toolName) stepEl.dataset.toolName = step.toolName;

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
      if (step.toolArgs) {
        this.renderExpandableArgs(stepEl, step.toolArgs);
      }
      if (step.isError) {
        this.decorateError(stepEl, step.errorContent ?? "");
      }
    } else if (step.text) {
      const needsTruncation = step.text.length > 120;
      const truncated = needsTruncation ? step.text.slice(0, 120) + "…" : step.text;
      bodyEl.createSpan({ cls: "lmsa-agentic-timeline-step-name", text: truncated });
      if (needsTruncation) {
        const expandEl = bodyEl.createDiv({ cls: "lmsa-agentic-timeline-step-expand" });
        expandEl.createEl("pre", { cls: "lmsa-agentic-timeline-arg-value", text: step.text });
        stepEl.classList.add("lmsa-agentic-timeline-step--expandable");
        stepEl.addEventListener("click", () => {
          stepEl.classList.toggle("is-expanded");
        });
      }
    }
  }

  /**
   * Render a clickable expand toggle that reveals the full tool arguments below
   * the step body. Clicking the step row toggles the expanded block.
   */
  private renderExpandableArgs(
    stepEl: HTMLElement,
    args: Record<string, unknown>,
  ): void {
    const expandEl = this.ensureExpandBlock(stepEl);
    for (const [key, value] of Object.entries(args)) {
      const entryEl = expandEl.createDiv({ cls: "lmsa-agentic-timeline-arg-entry" });
      entryEl.createSpan({ cls: "lmsa-agentic-timeline-arg-key", text: key });
      const valueStr = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      entryEl.createEl("pre", { cls: "lmsa-agentic-timeline-arg-value", text: valueStr });
    }
  }

  /**
   * The step's click-to-expand block, created on first use. Appended inside the step
   * body so the flex layout keeps it below the label (not beside the dot); the toggle
   * handler is wired once. Shared by the raw-args view and the error block.
   */
  private ensureExpandBlock(stepEl: HTMLElement): HTMLElement {
    const bodyEl =
      (stepEl.querySelector(".lmsa-agentic-timeline-step-body") as HTMLElement | null) ?? stepEl;
    let expandEl = bodyEl.querySelector<HTMLElement>(
      ":scope > .lmsa-agentic-timeline-step-expand",
    );
    if (!expandEl) {
      expandEl = bodyEl.createDiv({ cls: "lmsa-agentic-timeline-step-expand" });
    }
    if (!stepEl.classList.contains("lmsa-agentic-timeline-step--expandable")) {
      stepEl.classList.add("lmsa-agentic-timeline-step--expandable");
      stepEl.addEventListener("click", () => stepEl.classList.toggle("is-expanded"));
    }
    return expandEl;
  }

  /**
   * Mark a tool step as failed: a red dot, the exact result returned to the model in
   * the expand block, and a compact inline "Failed" label.
   *
   * The vault/edit review overlay owns the inline state label ("Failed" / "Declined" /
   * "No match") of any step it controls, so we add our own only when no overlay does:
   * read-only tools, and mutating failures that never became a reviewable op/hunk
   * (conversion errors, policy-deny, a no-match edit), those carry no overlay controls.
   * The overlay also strips this label when it later claims a step (its decorateStep),
   * so a historical re-render, where the base paints before the overlay, never doubles.
   */
  private decorateError(stepEl: HTMLElement, content: string): void {
    stepEl.classList.add("lmsa-agentic-timeline-step--error");
    const bodyEl =
      (stepEl.querySelector(".lmsa-agentic-timeline-step-body") as HTMLElement | null) ?? stepEl;
    const reviewed = !!bodyEl.querySelector(
      ":scope > .lmsa-vault-step-controls, :scope > .lmsa-edit-step-controls",
    );
    if (!reviewed && !bodyEl.querySelector(":scope > .lmsa-agentic-timeline-step-failed")) {
      bodyEl.createSpan({ cls: "lmsa-agentic-timeline-step-failed", text: "Failed" });
    }
    if (!content) return; // red dot + label suffice when there is no error text to show.
    const expandEl = this.ensureExpandBlock(stepEl);
    // Re-decoration (live result after a historical pre-render) replaces the block.
    expandEl.querySelector(":scope > .lmsa-agentic-timeline-error")?.remove();
    const errorEl = expandEl.createDiv({ cls: "lmsa-agentic-timeline-error" });
    errorEl.createSpan({
      cls: "lmsa-agentic-timeline-error-label",
      text: "error",
    });
    errorEl.createEl("pre", { cls: "lmsa-agentic-timeline-arg-value", text: content });
    expandEl.prepend(errorEl); // keep the error above any raw-args entries
  }
}

/** Base classes for a tool-call step: the type, the mutating category when applicable, and any extras. */
export function toolStepClasses(toolName: string | undefined, ...extra: string[]): string {
  const classes = ["lmsa-agentic-timeline-step", "lmsa-agentic-timeline-step--tool_call"];
  if (isMutatingTool(toolName)) classes.push("lmsa-agentic-timeline-step--mutating");
  classes.push(...extra);
  return classes.join(" ");
}

/**
 * Which queued pending placeholder a completing tool call claims. Prefers the one
 * already tagged with this call's id (the Claude Code path tags placeholders at
 * `start`), so out-of-order completion can't claim the wrong row; otherwise FIFO
 * (index 0, the plugin path, whose placeholders carry no id at streaming time).
 */
export function selectClaimIndex(
  pendingIds: ReadonlyArray<string | undefined>,
  toolCallId: string | undefined,
): number {
  if (toolCallId) {
    const idx = pendingIds.indexOf(toolCallId);
    if (idx >= 0) return idx;
  }
  return 0;
}

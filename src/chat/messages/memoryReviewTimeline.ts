import { setIcon } from "obsidian";
import type { MemoryMutation } from "../../tools/memory/handlers";
import type { ToolCall } from "../../tools/types";
import { TOOL_LABELS, pendingToolLabel } from "../../tools/metadata";

export type MemoryReviewStatus = "pending" | "applied" | "declined" | "failed";

export interface ReviewableMemoryProposal {
  id: string;
  sourceToolCallId: string;
  call: ToolCall;
  mutation: MemoryMutation;
  status: MemoryReviewStatus;
  error?: string;
}

export interface MemoryReviewTimelineOptions {
  timelineEl: HTMLElement;
  proposals: ReviewableMemoryProposal[];
  callbacks: {
    onApprove: (proposalId: string) => Promise<void>;
    onDecline: (proposalId: string) => void;
  };
}

const STATE_CLASSES = [
  "is-vault-awaiting",
  "is-vault-applied",
  "is-vault-failed",
  "is-vault-rejected",
];

/**
 * Folds transient memory proposals onto their existing agentic timeline steps.
 * Cancelled proposals are removed by the coordinator and never appear here again.
 */
export class MemoryReviewTimelineView {
  constructor(private readonly opts: MemoryReviewTimelineOptions) {
    this.cleanPriorDecorations();
    this.paint();
  }

  private cleanPriorDecorations(): void {
    const timeline = this.opts.timelineEl;
    timeline.querySelectorAll(".lmsa-memory-step-controls").forEach((element) => {
      element
        .closest(".lmsa-agentic-timeline-step")
        ?.classList.remove(...STATE_CLASSES);
      element.remove();
    });
    timeline
      .querySelectorAll(".lmsa-memory-review-preview")
      .forEach((element) => element.remove());
  }

  private paint(): void {
    for (const proposal of this.opts.proposals) {
      const step = this.locateStep(proposal);
      if (step) this.decorateStep(step, proposal);
    }
  }

  private locateStep(
    proposal: ReviewableMemoryProposal,
  ): HTMLElement | null {
    return this.opts.timelineEl.querySelector<HTMLElement>(
      `[data-tool-call-id="${CSS.escape(proposal.sourceToolCallId)}"]`,
    );
  }

  private decorateStep(
    step: HTMLElement,
    proposal: ReviewableMemoryProposal,
  ): void {
    step.classList.remove(...STATE_CLASSES);
    step.classList.add(statusClass(proposal.status));
    const body =
      step.querySelector<HTMLElement>(".lmsa-agentic-timeline-step-body") ??
      step;
    body
      .querySelector(":scope > .lmsa-agentic-timeline-step-failed")
      ?.remove();
    this.relabel(body, proposal);

    const controls = body.createDiv({
      cls: "lmsa-memory-step-controls",
    });
    controls.addEventListener("click", (event) => event.stopPropagation());
    this.renderControls(controls, proposal);
    this.renderPreview(body, proposal);
  }

  private relabel(
    body: HTMLElement,
    proposal: ReviewableMemoryProposal,
  ): void {
    const toolName =
      proposal.mutation.kind === "add" ? "add_memory" : "forget_memory";
    const name = memoryName(proposal.mutation);
    const nameElement = body.querySelector<HTMLElement>(
      ":scope > .lmsa-agentic-timeline-step-name",
    );
    if (nameElement) {
      nameElement.textContent =
        proposal.status === "applied"
          ? TOOL_LABELS[toolName] ?? toolName
          : pendingToolLabel(toolName);
    }
    let detail = body.querySelector<HTMLElement>(
      ":scope > .lmsa-agentic-timeline-step-detail",
    );
    if (!detail) {
      detail = body.createSpan({
        cls: "lmsa-agentic-timeline-step-detail",
      });
      if (nameElement) body.insertBefore(detail, nameElement.nextSibling);
    }
    detail.textContent =
      proposal.mutation.kind === "add"
        ? `${name}: ${proposal.mutation.memory.type}`
        : name;
  }

  private renderControls(
    controls: HTMLElement,
    proposal: ReviewableMemoryProposal,
  ): void {
    if (proposal.status === "pending") {
      controls.createSpan({
        cls: "lmsa-vault-step-pending",
        text: "pending approval",
      });
      const approve = controls.createEl("button", {
        cls: "lmsa-vault-step-btn lmsa-vault-step-btn--approve",
        attr: { "aria-label": "Approve" },
      });
      setIcon(approve, "check");
      approve.addEventListener("click", () => {
        approve.disabled = true;
        void this.opts.callbacks.onApprove(proposal.id);
      });

      const decline = controls.createEl("button", {
        cls: "lmsa-vault-step-btn lmsa-vault-step-btn--decline",
        attr: { "aria-label": "Decline" },
      });
      setIcon(decline, "x");
      decline.addEventListener("click", () =>
        this.opts.callbacks.onDecline(proposal.id),
      );
      return;
    }

    const text =
      proposal.status === "applied"
        ? "Applied"
        : proposal.status === "declined"
          ? "Declined"
          : "Failed";
    controls.createSpan({
      cls:
        proposal.status === "failed"
          ? "lmsa-vault-step-state is-error"
          : "lmsa-vault-step-state",
      text,
    });
  }

  private renderPreview(
    body: HTMLElement,
    proposal: ReviewableMemoryProposal,
  ): void {
    if (proposal.mutation.kind !== "add") return;
    const memory = proposal.mutation.memory;
    const preview = body.createDiv({
      cls: "lmsa-vault-timeline-preview lmsa-memory-review-preview",
    });
    preview.addEventListener("click", (event) => event.stopPropagation());
    preview.createEl("pre", {
      cls: "lmsa-agentic-timeline-arg-value",
      text: memory.description,
    });
    if (memory.content) {
      const details = preview.createEl("details", {
        cls: "lmsa-vault-replace-files",
      });
      details.createEl("summary", {
        cls: "lmsa-vault-replace-files-summary",
        text: "Content preview",
      });
      details.createEl("pre", {
        cls: "lmsa-agentic-timeline-arg-value",
        text: memory.content,
      });
    }
  }
}

function memoryName(mutation: MemoryMutation): string {
  return mutation.kind === "add" ? mutation.memory.name : mutation.name;
}

function statusClass(status: MemoryReviewStatus): string {
  switch (status) {
    case "pending":
      return "is-vault-awaiting";
    case "applied":
      return "is-vault-applied";
    case "declined":
      return "is-vault-rejected";
    case "failed":
      return "is-vault-failed";
  }
}

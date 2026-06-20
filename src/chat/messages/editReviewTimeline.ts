import { type App, Keymap, setIcon } from "obsidian";
import type { DiffHunk, EditStatus } from "../../editing/editTypes";
import type {
  EditReviewController,
  HunkReviewChange,
  InitialHunkView,
} from "../../editing/EditReviewController";
import { EDIT_TOOL_NAMES } from "../../tools/editing/definition";
import { DiffHunkView } from "./DiffHunkView";
import type { DiffMode } from "./DiffHunkView";

/**
 * Folds an edit proposal's diff review into the agentic timeline, the edit-channel
 * sibling of {@link ../messages/vaultReviewTimeline.VaultReviewTimelineView}. The
 * `propose_edit` / `update_frontmatter` calls are already timeline steps, so each
 * hunk's review lives *on its step*: approve / decline (and undo) sit inline on the
 * step row exactly like a vault op, and the diff renders always-visible directly
 * beneath the step, nested under the timeline so the connecting line stays
 * continuous. The step's own click-to-expand (the raw tool args) is left intact for
 * inspection/debugging.
 *
 * A pure view over {@link EditReviewController}: approve/decline/undo route through
 * the controller and its broadcasts keep this view and the in-note overlay in sync.
 * Hunks map to steps by {@link DiffHunk.id} (=== the originating tool-call id, tagged
 * on the element as `data-tool-call-id`), with a positional fallback by edit-tool name
 * and a synthetic fallback row, so a regex-parsed edit (no tool call) is never
 * silently unreviewable.
 */

export interface EditReviewTimelineOptions {
  timelineEl: HTMLElement;
  app: App;
  controller: EditReviewController;
  /** Live in-loop mount renders by hunk status; durable/history honors the applied record. */
  live?: boolean;
}

/** Per-hunk state class on the step element, drives the status dot tint. */
function stateClass(view: InitialHunkView, noMatch: boolean): string {
  if (view === "applied") return "is-edit-applied";
  if (view === "skipped") return "is-edit-skipped";
  return noMatch ? "is-edit-nomatch" : "is-edit-pending";
}

const ALL_EDIT_STATE_CLASSES = [
  "is-edit-pending",
  "is-edit-applied",
  "is-edit-skipped",
  "is-edit-nomatch",
];

/** The diff card's border status mirrors the hunk's review state. */
function toEditStatus(view: InitialHunkView): EditStatus {
  if (view === "applied") return "accepted";
  if (view === "skipped") return "rejected";
  return "pending";
}

/** Per-hunk decoration handles, so a controller broadcast can update in place. */
interface HunkEntry {
  hunk: DiffHunk;
  diffView: DiffHunkView;
  controlsEl: HTMLElement;
  stepEl: HTMLElement;
  noMatch: boolean;
}

export class EditReviewTimelineView {
  private readonly entries = new Map<string, HunkEntry>();
  private readonly syntheticSteps = new Map<string, HTMLElement>();
  private fallbackListEl: HTMLElement | null = null;
  // Side-by-side is the default review view; the per-card toggle still offers unified.
  private diffMode: DiffMode = "split";
  private readonly unsubscribe: () => void;

  constructor(private readonly opts: EditReviewTimelineOptions) {
    this.cleanPriorDecorations();
    this.paint();
    this.unsubscribe = this.opts.controller.subscribe((change) => this.onChange(change));
  }

  /** Drop the controller subscription (for callers re-rendering over a kept controller). */
  destroy(): void {
    this.unsubscribe();
  }

  // -----------------------------------------------------------------------
  // Painting
  // -----------------------------------------------------------------------

  /**
   * Strip decorations a prior view left on this timeline, so re-mounting on an
   * already-decorated DOM (history re-render, or the live per-round re-render)
   * doesn't stack duplicate controls, diffs, or state classes. The step's own raw-args
   * expand block is left alone, it isn't ours.
   */
  private cleanPriorDecorations(): void {
    const t = this.opts.timelineEl;
    t.querySelectorAll(".lmsa-edit-review-fallback").forEach((e) => e.remove());
    t.querySelectorAll(".lmsa-edit-step-controls, .lmsa-edit-timeline-hunk").forEach((e) =>
      e.remove(),
    );
    t.querySelectorAll(".lmsa-agentic-timeline-step").forEach((e) =>
      e.classList.remove(...ALL_EDIT_STATE_CLASSES),
    );
  }

  private paint(): void {
    const used = new Set<HTMLElement>();
    const fileName = this.fileName();
    for (const hunk of this.opts.controller.proposal.hunks) {
      this.decorateStep(this.locateStep(hunk, used), hunk, fileName);
    }
  }

  private fileName(): string {
    const path = this.opts.controller.targetFilePath;
    return path.split("/").pop() ?? path;
  }

  /**
   * Find the timeline step for a hunk, or lazily create a synthetic stand-in.
   * Primary match is by tool-call id (`hunk.id` === `data-tool-call-id`); fallback
   * is the next unclaimed edit-tool step in document order.
   */
  private locateStep(hunk: DiffHunk, used: Set<HTMLElement>): HTMLElement {
    const byId = this.opts.timelineEl.querySelector<HTMLElement>(
      `[data-tool-call-id="${CSS.escape(hunk.id)}"]`,
    );
    if (byId && !used.has(byId)) {
      used.add(byId);
      return byId;
    }

    const positional = Array.from(
      this.opts.timelineEl.querySelectorAll<HTMLElement>(
        ".lmsa-agentic-timeline-step--tool_call[data-tool-name]",
      ),
    ).find(
      (s) =>
        EDIT_TOOL_NAMES.has(s.dataset.toolName ?? "") &&
        !s.closest(".lmsa-edit-review-fallback") &&
        !used.has(s),
    );
    if (positional) {
      used.add(positional);
      return positional;
    }

    return this.ensureSyntheticStep(hunk);
  }

  private ensureSyntheticStep(hunk: DiffHunk): HTMLElement {
    const existing = this.syntheticSteps.get(hunk.id);
    if (existing) return existing;

    if (!this.fallbackListEl) {
      this.fallbackListEl = this.opts.timelineEl.createDiv({
        cls: "lmsa-agentic-timeline-list lmsa-edit-review-fallback",
      });
    }
    const stepEl = this.fallbackListEl.createDiv({
      cls: "lmsa-agentic-timeline-step lmsa-agentic-timeline-step--tool_call",
    });
    const dotEl = stepEl.createDiv({ cls: "lmsa-agentic-timeline-dot" });
    setIcon(dotEl, "file-pen");
    const bodyEl = stepEl.createDiv({ cls: "lmsa-agentic-timeline-step-body" });
    bodyEl.createSpan({ cls: "lmsa-agentic-timeline-step-name", text: "Proposed edit" });
    this.syntheticSteps.set(hunk.id, stepEl);
    return stepEl;
  }

  private decorateStep(stepEl: HTMLElement, hunk: DiffHunk, fileName: string): void {
    const noMatch = hunk.resolvedEdit.confidence === 0;
    const view = this.opts.live
      ? this.opts.controller.liveHunkView(hunk.id)
      : this.opts.controller.initialHunkView(hunk.id);

    stepEl.classList.remove(...ALL_EDIT_STATE_CLASSES);
    stepEl.classList.add(stateClass(view, noMatch));

    const bodyEl =
      stepEl.querySelector<HTMLElement>(".lmsa-agentic-timeline-step-body") ?? stepEl;
    bodyEl.querySelector(":scope > .lmsa-edit-step-controls")?.remove();
    bodyEl.querySelector(":scope > .lmsa-edit-timeline-hunk")?.remove();
    // This step is reviewed, so the overlay owns its state label, drop the base
    // "Failed" word the timeline may have added (it paints first on a history re-render).
    bodyEl.querySelector(":scope > .lmsa-agentic-timeline-step-failed")?.remove();

    // Approve / decline / undo live inline on the step row (parity with vault ops).
    // Clicks here must not toggle the step's raw-args expand.
    const controlsEl = bodyEl.createDiv({ cls: "lmsa-edit-step-controls" });
    controlsEl.addEventListener("click", (e) => e.stopPropagation());

    // The diff renders always-visible, nested under the step row (full-width, so it
    // wraps below the row and stays left of the timeline's connecting line). It is a
    // pure display, its accept/reject are suppressed; the step controls own those.
    const hunkWrap = bodyEl.createDiv({ cls: "lmsa-edit-timeline-hunk" });
    hunkWrap.addEventListener("click", (e) => e.stopPropagation());
    const diffView = new DiffHunkView(
      hunkWrap,
      hunk,
      {
        onAccept: () => undefined,
        onReject: () => undefined,
        onUndo: () => undefined,
        onModeChange: (mode) => this.handleModeChange(mode),
        onOpenFile: (evt) => this.openTargetFile(evt, hunk.resolvedEdit.startLine),
      },
      { fileName },
      this.diffMode,
      { showReviewControls: false },
    );
    diffView.setStatus(toEditStatus(view));

    const entry: HunkEntry = { hunk, diffView, controlsEl, stepEl, noMatch };
    this.entries.set(hunk.id, entry);
    this.renderControls(entry, view);
  }

  /** Inline approve/decline (pending) or status + undo (terminal) on the step row. */
  private renderControls(entry: HunkEntry, view: InitialHunkView): void {
    const { controlsEl, hunk, noMatch } = entry;
    controlsEl.empty();

    if (view === "applied") {
      controlsEl.createSpan({ cls: "lmsa-edit-step-state", text: "Applied" });
      const undo = this.iconButton(controlsEl, "undo-2", "Undo", "undo");
      undo.addEventListener("click", () => void this.opts.controller.undo(hunk.id));
      return;
    }
    if (view === "skipped") {
      controlsEl.createSpan({ cls: "lmsa-edit-step-state", text: "Skipped" });
      return;
    }

    // Pending. A no-match can't be applied, offer only a way to dismiss it.
    if (noMatch) {
      controlsEl.createSpan({ cls: "lmsa-edit-step-state is-error", text: "No match" });
      const decline = this.iconButton(controlsEl, "x", "Dismiss", "decline");
      decline.addEventListener("click", () => this.opts.controller.reject(hunk.id));
      return;
    }

    controlsEl.createSpan({ cls: "lmsa-edit-step-pending", text: "pending review" });
    const approve = this.iconButton(controlsEl, "check", "Accept", "approve");
    approve.addEventListener("click", () => void this.opts.controller.accept(hunk.id));
    const decline = this.iconButton(controlsEl, "x", "Reject", "decline");
    decline.addEventListener("click", () => this.opts.controller.reject(hunk.id));
  }

  private iconButton(
    parent: HTMLElement,
    icon: string,
    label: string,
    variant: "approve" | "decline" | "undo",
  ): HTMLButtonElement {
    const btn = parent.createEl("button", {
      cls: `lmsa-edit-step-btn lmsa-edit-step-btn--${variant}`,
      attr: { "aria-label": label },
    });
    setIcon(btn, icon);
    return btn;
  }

  private handleModeChange(mode: DiffMode): void {
    if (mode === this.diffMode) return;
    this.diffMode = mode;
    for (const { diffView } of this.entries.values()) {
      diffView.setDiffMode(mode);
    }
  }

  private openTargetFile(evt: MouseEvent, startLine: number): void {
    void this.opts.app.workspace.openLinkText(
      this.opts.controller.targetFilePath,
      "",
      Keymap.isModEvent(evt),
      { eState: { line: Math.max(0, startLine - 1) } },
    );
  }

  // -----------------------------------------------------------------------
  // Controller broadcasts, keep this view in sync with the in-note overlay
  // -----------------------------------------------------------------------

  private onChange(change: HunkReviewChange): void {
    const entry = this.entries.get(change.hunkId);
    if (!entry) return;

    const view: InitialHunkView =
      change.status === "accepted" ? "applied" : change.status === "rejected" ? "skipped" : "pending";

    entry.stepEl.classList.remove(...ALL_EDIT_STATE_CLASSES);
    entry.stepEl.classList.add(stateClass(view, entry.noMatch));
    entry.diffView.setStatus(change.status);
    this.renderControls(entry, view);
  }
}

import { type App, Keymap, setIcon } from "obsidian";
import type { DiffHunk, EditStatus } from "../../editing/editTypes";
import type {
  EditReviewController,
  HunkReviewChange,
  InitialHunkView,
} from "../../editing/EditReviewController";
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
 * on the element as `data-tool-call-id`). A review without exact identity uses a
 * synthetic history row and never claims a provider declaration.
 */

export interface EditReviewTimelineOptions {
  timelineEl: HTMLElement;
  /** Canonical placement by exact declaration identity (ADR-0031). */
  findActionHostByToolCallId?: (toolCallId: string) => HTMLElement | null;
  app: App;
  /**
   * One controller per edited file (ADR-0010). Hunks map to steps by tool-call id
   * across all controllers, so N files render one card per hunk on a single timeline,
   * with one aggregate bulk bar spanning them.
   */
  controllers: EditReviewController[];
  /** Live in-loop mount renders by hunk status; durable/history honors the applied record. */
  live?: boolean;
  /** Ambiguous legacy ownership renders status and diff without mutation controls. */
  readOnly?: boolean;
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
  /** The controller (file) this hunk belongs to; routes accept/reject/undo/open. */
  controller: EditReviewController;
  diffView: DiffHunkView;
  controlsEl: HTMLElement;
  stateEl: HTMLElement;
  noMatch: boolean;
}

interface EditReviewMounts {
  stateEl: HTMLElement;
  controlsHostEl: HTMLElement;
  presentationHostEl: HTMLElement;
}

/**
 * The canonical assistant turn exposes a compact inline action host inside the
 * tool body. Keep only controls there, and mount the full review presentation as
 * a sibling so its 100% flex basis is relative to the complete tool row.
 */
function resolveEditReviewMounts(stepEl: HTMLElement): EditReviewMounts {
  if (stepEl.matches(".lmsa-assistant-turn-action-host")) {
    const presentationHostEl = stepEl.parentElement ?? stepEl;
    return {
      stateEl:
        stepEl.closest<HTMLElement>(".lmsa-assistant-turn-item") ?? stepEl,
      controlsHostEl: stepEl,
      presentationHostEl,
    };
  }

  const bodyEl =
    stepEl.querySelector<HTMLElement>(".lmsa-agentic-timeline-step-body") ??
    stepEl;
  return {
    stateEl: stepEl,
    controlsHostEl: bodyEl,
    presentationHostEl: bodyEl,
  };
}

export class EditReviewTimelineView {
  private readonly entries = new Map<string, HunkEntry>();
  private readonly syntheticSteps = new Map<string, HTMLElement>();
  private fallbackListEl: HTMLElement | null = null;
  // Side-by-side is the default review view; the per-card toggle still offers unified.
  private diffMode: DiffMode = "split";
  private readonly unsubscribes: Array<() => void>;

  constructor(private readonly opts: EditReviewTimelineOptions) {
    this.cleanPriorDecorations();
    this.paint();
    // Subscribe to every file's controller so a change to any of them repaints in place.
    this.unsubscribes = this.opts.controllers.map((c) => c.subscribe((change) => this.onChange(change)));
  }

  /** Drop every controller subscription (for callers re-rendering over kept controllers). */
  destroy(): void {
    for (const unsub of this.unsubscribes) unsub();
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
    t.querySelectorAll(
      ".lmsa-agentic-timeline-step, .lmsa-assistant-turn-item",
    ).forEach((e) => e.classList.remove(...ALL_EDIT_STATE_CLASSES));
  }

  private paint(): void {
    // One card per hunk across every file's controller; the file name is derived per
    // controller so a multi-file turn labels each card with its own note (ADR-0010).
    for (const controller of this.opts.controllers) {
      const fileName = fileNameOf(controller);
      for (const hunk of controller.proposal.hunks) {
        this.decorateStep(this.locateStep(hunk), hunk, controller, fileName);
      }
    }
  }

  /**
   * Find the exact timeline step for a hunk, or create a synthetic history row.
   */
  private locateStep(hunk: DiffHunk): HTMLElement {
    if (this.opts.findActionHostByToolCallId) {
      const host = this.opts.findActionHostByToolCallId(hunk.id);
      if (!host) {
        throw new Error(
          `No assistant turn action host exists for edit call "${hunk.id}".`,
        );
      }
      return host;
    }
    const byId = this.opts.timelineEl.querySelector<HTMLElement>(
      `[data-tool-call-id="${CSS.escape(hunk.id)}"]`,
    );
    if (byId) return byId;

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

  private decorateStep(
    stepEl: HTMLElement,
    hunk: DiffHunk,
    controller: EditReviewController,
    fileName: string,
  ): void {
    const noMatch = hunk.resolvedEdit.confidence === 0;
    const view = this.opts.live
      ? controller.liveHunkView(hunk.id)
      : controller.initialHunkView(hunk.id);
    const { stateEl, controlsHostEl, presentationHostEl } =
      resolveEditReviewMounts(stepEl);

    stateEl.classList.remove(...ALL_EDIT_STATE_CLASSES);
    stateEl.classList.add(stateClass(view, noMatch));

    controlsHostEl.querySelector(":scope > .lmsa-edit-step-controls")?.remove();
    presentationHostEl.querySelector(":scope > .lmsa-edit-timeline-hunk")?.remove();
    // This step is reviewed, so the overlay owns its state label, drop the base
    // "Failed" word the timeline may have added (it paints first on a history re-render).
    presentationHostEl
      .querySelector(":scope > .lmsa-agentic-timeline-step-failed")
      ?.remove();

    // Approve / decline / undo live inline on the step row (parity with vault ops).
    // Clicks here must not toggle the step's raw-args expand.
    const controlsEl = controlsHostEl.createDiv({
      cls: "lmsa-edit-step-controls",
    });
    controlsEl.addEventListener("click", (e) => e.stopPropagation());

    // The diff is a full-width presentation below the row. It must not be nested in
    // the canonical inline action host, whose width is intentionally content-sized.
    const hunkWrap = presentationHostEl.createDiv({
      cls: "lmsa-edit-timeline-hunk",
    });
    if (presentationHostEl !== controlsHostEl) {
      controlsHostEl.after(hunkWrap);
    }
    hunkWrap.addEventListener("click", (e) => e.stopPropagation());
    const diffView = new DiffHunkView(
      hunkWrap,
      hunk,
      {
        onAccept: () => undefined,
        onReject: () => undefined,
        onUndo: () => undefined,
        onModeChange: (mode) => this.handleModeChange(mode),
        onOpenFile: (evt) => this.openTargetFile(evt, controller, hunk.resolvedEdit.startLine),
      },
      { fileName },
      this.diffMode,
      { showReviewControls: false },
    );
    diffView.setStatus(toEditStatus(view));

    const entry: HunkEntry = {
      hunk,
      controller,
      diffView,
      controlsEl,
      stateEl,
      noMatch,
    };
    this.entries.set(hunk.id, entry);
    this.renderControls(entry, view);
  }

  /** Inline approve/decline (pending) or status + undo (terminal) on the step row. */
  private renderControls(entry: HunkEntry, view: InitialHunkView): void {
    const { controlsEl, hunk, noMatch, controller } = entry;
    controlsEl.empty();

    if (this.opts.readOnly) {
      controlsEl.createSpan({
        cls: "lmsa-edit-step-state",
        text:
          view === "applied"
            ? "Applied"
            : view === "skipped"
              ? "Skipped"
              : noMatch
                ? "No match"
                : "Historical review",
      });
      return;
    }

    if (view === "applied") {
      controlsEl.createSpan({ cls: "lmsa-edit-step-state", text: "Applied" });
      const undo = this.iconButton(controlsEl, "undo-2", "Undo", "undo");
      undo.addEventListener("click", () => void controller.undo(hunk.id));
      return;
    }
    if (view === "skipped") {
      controlsEl.createSpan({ cls: "lmsa-edit-step-state", text: "Skipped" });
      return;
    }

    // Pending. A no-match can't be applied, and it never parked a decision either, so
    // it keeps its own dismiss affordance.
    if (noMatch) {
      controlsEl.createSpan({ cls: "lmsa-edit-step-state is-error", text: "No match" });
      const decline = this.iconButton(controlsEl, "x", "Dismiss", "decline");
      decline.addEventListener("click", () => controller.reject(hunk.id));
      return;
    }

    // The accept / reject decision is made in the composer drawer while the generation
    // is live (RFC-0012); the timeline is the record, so this is a status label. The
    // diff card and the applied-state Undo above it both stay.
    controlsEl.createSpan({ cls: "lmsa-edit-step-pending", text: "pending review" });
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

  private openTargetFile(evt: MouseEvent, controller: EditReviewController, startLine: number): void {
    void this.opts.app.workspace.openLinkText(
      controller.targetFilePath,
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

    entry.stateEl.classList.remove(...ALL_EDIT_STATE_CLASSES);
    entry.stateEl.classList.add(stateClass(view, entry.noMatch));
    entry.diffView.setStatus(change.status);
    this.renderControls(entry, view);
  }
}

/** The leaf note name for a controller's file, shown on that file's diff cards. */
function fileNameOf(controller: EditReviewController): string {
  const path = controller.targetFilePath;
  return path.split("/").pop() ?? path;
}

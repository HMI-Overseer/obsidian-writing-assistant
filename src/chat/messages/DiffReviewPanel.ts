import { type App, Component, Keymap, MarkdownRenderer } from "obsidian";
import type { EditReviewController, HunkReviewChange } from "../../editing/EditReviewController";
import { DiffHunkView } from "./DiffHunkView";
import type { DiffMode } from "./DiffHunkView";

/**
 * Chat-bubble renderer for an edit proposal's diff. A pure view over an
 * {@link EditReviewController}: accept / reject / undo are forwarded to the
 * controller, and the panel reacts to the controller's broadcasts so it stays in
 * sync with the in-note overlay (which drives the same controller).
 *
 * This is the durable, persisted review surface — it renders from saved state on
 * reload, when the target file is closed, and when scrolling back through the
 * transcript, whether or not the note is open.
 */
export class DiffReviewPanel {
  private readonly hunkViews = new Map<string, DiffHunkView>();
  private diffMode: DiffMode = "split";
  private readonly unsubscribe: () => void;
  /** Live (in-loop) panels render by hunk status; durable panels honor the applied record. */
  private readonly live: boolean;

  constructor(
    private readonly containerEl: HTMLElement,
    private readonly app: App,
    private readonly owner: Component,
    private readonly controller: EditReviewController,
    opts?: { live?: boolean }
  ) {
    this.live = opts?.live ?? false;
    this.render();
    // The subscription shares the controller's lifetime: when this panel is
    // re-rendered at finalization, renderProposalPanels builds a new controller and
    // detaches the old one from the InlineDiffManager, leaving panel + controller an
    // isolated cycle for GC. The in-loop live review keeps one controller and
    // re-renders the panel per round, so it calls {@link destroy} first to drop the
    // stale subscription.
    this.unsubscribe = this.controller.subscribe((change) => this.onChange(change));
  }

  /** Drop the controller subscription (for callers that re-render over a kept controller). */
  destroy(): void {
    this.unsubscribe();
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  private render(): void {
    this.containerEl.empty();
    this.containerEl.addClass("lmsa-chat-window-diff-panel");

    this.renderProse();
    this.renderHunks();
    this.applyInitialStates();
  }

  private renderProse(): void {
    const prose = this.controller.proposal.prose;
    if (!prose) return;

    const proseEl = this.containerEl.createDiv({ cls: "lmsa-chat-window-diff-prose" });
    const renderChild = new Component();
    this.owner.addChild(renderChild);

    const sourcePath = this.app.workspace.getActiveFile()?.path ?? "";
    MarkdownRenderer.render(this.app, prose, proseEl, sourcePath, renderChild).catch(() => {
      proseEl.setText(prose);
    });
  }

  private renderHunks(): void {
    const hunksContainer = this.containerEl.createDiv({ cls: "lmsa-chat-window-diff-hunks" });

    const path = this.controller.targetFilePath;
    const fileName = path.split("/").pop() ?? path;

    for (const hunk of this.controller.proposal.hunks) {
      const view = new DiffHunkView(
        hunksContainer,
        hunk,
        {
          onAccept: (id) => void this.controller.accept(id),
          onReject: (id) => this.controller.reject(id),
          onUndo: (id) => void this.controller.undo(id),
          onModeChange: (mode) => this.handleModeChange(mode),
          onOpenFile: (evt) => this.openTargetFile(evt, hunk.resolvedEdit.startLine),
        },
        { fileName },
        this.diffMode
      );
      this.hunkViews.set(hunk.id, view);
    }
  }

  /**
   * Open the edited note at the hunk's line (concern B), honoring mod-click. The
   * target lights up the same controller's overlay, so accepting there resolves
   * the very review shown here.
   */
  private openTargetFile(evt: MouseEvent, startLine: number): void {
    void this.app.workspace.openLinkText(
      this.controller.targetFilePath,
      "",
      Keymap.isModEvent(evt),
      { eState: { line: Math.max(0, startLine - 1) } },
    );
  }

  /** Reflect persisted state (applied / skipped) onto freshly-rendered hunks. */
  private applyInitialStates(): void {
    for (const hunk of this.controller.proposal.hunks) {
      const view = this.hunkViews.get(hunk.id);
      if (!view) continue;
      const state = this.live
        ? this.controller.liveHunkView(hunk.id)
        : this.controller.initialHunkView(hunk.id);
      if (state === "applied") {
        view.setAppliedWithUndo();
      } else if (state === "skipped") {
        view.setApplied(false);
      }
    }
  }

  private handleModeChange(mode: DiffMode): void {
    if (mode === this.diffMode) return;
    this.diffMode = mode;
    for (const view of this.hunkViews.values()) {
      view.setDiffMode(mode);
    }
  }

  // -----------------------------------------------------------------------
  // Controller broadcasts — keep the panel in sync with any other renderer
  // -----------------------------------------------------------------------

  private onChange(change: HunkReviewChange): void {
    const view = this.hunkViews.get(change.hunkId);
    if (!view) return;

    if (change.status === "accepted") {
      view.setAppliedWithUndo();
    } else if (change.status === "rejected") {
      view.setApplied(false);
    } else if (change.status === "pending") {
      view.resetToPending();
    }
  }
}

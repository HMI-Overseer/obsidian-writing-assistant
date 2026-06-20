import { MarkdownView, type App, type EventRef } from "obsidian";
import type { EditorView } from "@codemirror/view";
import type { EditReviewController } from "../EditReviewController";
import { clearInlineHunks, setInlineHunks, type InlineHunk } from "./inlineDiffState";

interface Registration {
  controller: EditReviewController;
  unsubscribe: () => void;
}

/**
 * Binds {@link EditReviewController}s to the live Markdown editor so a proposal's
 * pending hunks render inline in the note it edits, the second renderer over the
 * same controller as the timeline-folded edit review.
 *
 * One registration per target file (latest proposal wins); the overlay shows
 * whichever registered file is currently active. The controller stays the single
 * owner, the manager only translates pending hunks into decorations and pushes
 * accept / reject back through the controller.
 */
export class InlineDiffManager {
  private readonly registrations = new Map<string, Registration>();
  /** The editor currently displaying an overlay, so it can be cleared on switch. */
  private boundView: EditorView | null = null;

  constructor(private readonly app: App) {}

  /** Workspace listeners that re-evaluate the overlay; pass to `registerEvent`. */
  workspaceEvents(): EventRef[] {
    return [
      this.app.workspace.on("active-leaf-change", () => this.refresh()),
      this.app.workspace.on("file-open", () => this.refresh()),
    ];
  }

  /**
   * Show this controller's pending hunks inline whenever its target file is the
   * active editor. A controller with nothing left to review is unregistered.
   */
  attach(controller: EditReviewController): void {
    const path = controller.targetFilePath;
    this.registrations.get(path)?.unsubscribe();

    if (!controller.hasPendingHunks()) {
      this.registrations.delete(path);
      this.refresh();
      return;
    }

    const unsubscribe = controller.subscribe(() => {
      if (!controller.hasPendingHunks()) {
        this.registrations.get(path)?.unsubscribe();
        this.registrations.delete(path);
      }
      this.refresh();
    });
    this.registrations.set(path, { controller, unsubscribe });
    this.refresh();
  }

  /** Re-sync the overlay with the active editor and its registered controller. */
  refresh(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const cm = (view?.editor as unknown as { cm?: EditorView })?.cm ?? null;

    // Clear a stale overlay left on a now-inactive editor.
    if (this.boundView && this.boundView !== cm) {
      this.boundView.dispatch({ effects: clearInlineHunks.of(null) });
      this.boundView = null;
    }

    if (!view || !cm) return;

    const registration = view.file ? this.registrations.get(view.file.path) : undefined;
    if (!registration) {
      cm.dispatch({ effects: clearInlineHunks.of(null) });
      this.boundView = null;
      return;
    }

    cm.dispatch({ effects: setInlineHunks.of(this.toInlineHunks(registration.controller)) });
    this.boundView = cm;
  }

  private toInlineHunks(controller: EditReviewController): InlineHunk[] {
    return controller.pendingHunks().map((hunk) => ({
      id: hunk.id,
      matchedText: hunk.resolvedEdit.matchedText,
      replaceText: hunk.resolvedEdit.editBlock.replaceText,
      matchOffset: hunk.resolvedEdit.matchOffset,
      onAccept: () => void controller.accept(hunk.id),
      onReject: () => controller.reject(hunk.id),
    }));
  }

  destroy(): void {
    for (const { unsubscribe } of this.registrations.values()) unsubscribe();
    this.registrations.clear();
    if (this.boundView) {
      this.boundView.dispatch({ effects: clearInlineHunks.of(null) });
      this.boundView = null;
    }
  }
}

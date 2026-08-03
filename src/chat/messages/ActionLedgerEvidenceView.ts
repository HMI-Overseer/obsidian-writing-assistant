import { type App, Keymap, normalizePath } from "obsidian";
import type { ToolActionLedgerEntry } from "../../shared/types";
import { buildWritePreviewHunk } from "../../vault-ops/writePreview";
import {
  buildActionEvidence,
  type ActionEvidence,
} from "./actionLedgerEvidence";
import { DiffHunkView, type DiffMode } from "./DiffHunkView";

/** A pure display card: every decision it could report is made elsewhere. */
const RECORD_ONLY_CALLBACKS = {
  onAccept: () => undefined,
  onReject: () => undefined,
  onUndo: () => undefined,
};

/**
 * The durable half of a reviewed step: what the change actually was.
 *
 * Mounts under one action-ledger entry as the full-width sibling of its control host,
 * in the same slot the live review's diff took, and rebuilds that diff from the
 * ledger ({@link buildActionEvidence}). The live views own this slot while a
 * generation runs and hand it over at finalization, so exactly one of them paints at
 * a time.
 *
 * A record, never an actor: nothing here approves, applies, or undoes. The entry's
 * remaining controls live on the step row, rendered from the same ledger.
 */
export class ActionLedgerEvidenceView {
  readonly element: HTMLElement;

  /** Side-by-side is the default; the per-card toggle switches every card at once. */
  private diffMode: DiffMode = "split";
  private readonly diffViews: DiffHunkView[] = [];
  private renderedSignature: string | null = null;
  /** Invalidates in-flight disk reads whose render has already been replaced. */
  private renderToken = 0;

  constructor(
    private readonly app: App,
    documentHostEl: HTMLElement,
  ) {
    // Created attached, then detached: `createDiv` cannot build a detached element on
    // a non-main document (ADR-0026), and the host coordinator places it later.
    this.element = documentHostEl.createDiv({
      cls: "lmsa-action-evidence",
    });
    this.element.remove();
    // A tool step row toggles its raw-argument disclosure on click. Reading a diff,
    // opening a file link, or expanding the affected-file list must not also do that.
    this.element.addEventListener("click", (event) => event.stopPropagation());
  }

  /** Repaint only when the projected evidence actually changed. */
  refresh(entry: ToolActionLedgerEntry): void {
    const evidence = buildActionEvidence(entry);
    const signature = JSON.stringify(evidence);
    if (signature === this.renderedSignature) return;
    this.renderedSignature = signature;
    this.render(evidence);
  }

  destroy(): void {
    this.renderToken += 1;
  }

  private render(evidence: readonly ActionEvidence[]): void {
    this.renderToken += 1;
    this.element.empty();
    this.diffViews.length = 0;
    for (const item of evidence) {
      switch (item.kind) {
        case "edit_diff":
          this.renderEditDiff(item);
          break;
        case "write_diff":
          this.renderWriteDiff(item);
          break;
        case "replace_files":
          this.renderReplaceFiles(item);
          break;
        case "memory_record":
          this.renderMemoryRecord(item);
          break;
      }
    }
  }

  private renderEditDiff(
    item: Extract<ActionEvidence, { kind: "edit_diff" }>,
  ): void {
    const hunkEl = this.element.createDiv({
      cls: "lmsa-edit-timeline-hunk",
    });
    this.diffViews.push(
      new DiffHunkView(
        hunkEl,
        {
          id: item.targetId,
          resolvedEdit: item.resolvedEdit,
          status: item.status,
        },
        {
          ...RECORD_ONLY_CALLBACKS,
          onModeChange: (mode) => this.setDiffMode(mode),
          onOpenFile: (event) =>
            this.openFile(event, item.filePath, item.resolvedEdit.startLine),
        },
        { fileName: leafName(item.filePath) },
        this.diffMode,
        { showReviewControls: false },
      ),
    );
  }

  /**
   * A write's preview, headerless like its live counterpart: the step row already
   * names the file, and "Exact match" confidence is meaningless for a whole-file write.
   */
  private renderWriteDiff(
    item: Extract<ActionEvidence, { kind: "write_diff" }>,
  ): void {
    const previewEl = this.element.createDiv({
      cls: "lmsa-vault-timeline-preview",
    });
    if (item.beforeIsRecorded) {
      this.paintWritePreview(previewEl, item, item.before);
      return;
    }
    const token = this.renderToken;
    const file = this.app.vault.getFileByPath(normalizePath(item.path));
    if (!file) {
      // The overwrite never applied and its target is gone, so the only honest
      // "before" is nothing at all: show the proposed content as an all-add preview.
      this.paintWritePreview(previewEl, item, null);
      return;
    }
    void this.app.vault.read(file).then(
      (before) => {
        if (token !== this.renderToken) return;
        this.paintWritePreview(previewEl, item, before);
      },
      () => {
        if (token !== this.renderToken) return;
        this.paintWritePreview(previewEl, item, null);
      },
    );
  }

  private paintWritePreview(
    previewEl: HTMLElement,
    item: Extract<ActionEvidence, { kind: "write_diff" }>,
    before: string | null,
  ): void {
    previewEl.empty();
    const hunk = buildWritePreviewHunk(before, item.content, item.targetId);
    this.diffViews.push(
      new DiffHunkView(
        previewEl,
        { ...hunk, status: item.status },
        {
          ...RECORD_ONLY_CALLBACKS,
          onModeChange: () => undefined,
          onOpenFile: () => undefined,
        },
        { fileName: "" },
        "split",
        { showReviewControls: false, showHeader: false },
      ),
    );
  }

  /**
   * Which notes a vault-wide replace rewrote. Collapsed, with per-file match counts
   * and no per-file diffs, exactly as the live review offers it: the blast radius is
   * the fact worth keeping, and N diffs would bury the rest of the turn.
   */
  private renderReplaceFiles(
    item: Extract<ActionEvidence, { kind: "replace_files" }>,
  ): void {
    const details = this.element.createEl("details", {
      cls: "lmsa-vault-replace-files",
    });
    const count = item.files.length;
    details.createEl("summary", {
      cls: "lmsa-vault-replace-files-summary",
      text: `${count} note${count === 1 ? "" : "s"} affected`,
    });
    const listEl = details.createDiv({ cls: "lmsa-vault-replace-files-list" });
    for (const file of item.files) {
      const rowEl = listEl.createDiv({ cls: "lmsa-vault-replace-file" });
      const linkEl = rowEl.createEl("a", {
        cls: "lmsa-vault-replace-file-path internal-link",
        text: file.path,
        attr: { href: "#", "aria-label": `Open ${file.path}` },
      });
      linkEl.addEventListener("click", (event) => {
        event.preventDefault();
        void this.app.workspace.openLinkText(
          file.path,
          "",
          Keymap.isModEvent(event),
        );
      });
      if (typeof file.count === "number") {
        rowEl.createSpan({
          cls: "lmsa-vault-replace-file-count",
          text: `${file.count} match${file.count === 1 ? "" : "es"}`,
        });
      }
    }
  }

  private renderMemoryRecord(
    item: Extract<ActionEvidence, { kind: "memory_record" }>,
  ): void {
    const previewEl = this.element.createDiv({
      cls: "lmsa-vault-timeline-preview lmsa-memory-review-preview",
    });
    previewEl.createEl("pre", {
      cls: "lmsa-agentic-timeline-arg-value",
      text: item.description,
    });
    if (!item.content) return;
    const details = previewEl.createEl("details", {
      cls: "lmsa-vault-replace-files",
    });
    details.createEl("summary", {
      cls: "lmsa-vault-replace-files-summary",
      text: "Content preview",
    });
    details.createEl("pre", {
      cls: "lmsa-agentic-timeline-arg-value",
      text: item.content,
    });
  }

  private setDiffMode(mode: DiffMode): void {
    if (mode === this.diffMode) return;
    this.diffMode = mode;
    for (const view of this.diffViews) view.setDiffMode(mode);
  }

  private openFile(
    event: MouseEvent,
    filePath: string,
    startLine: number,
  ): void {
    void this.app.workspace.openLinkText(
      filePath,
      "",
      Keymap.isModEvent(event),
      { eState: { line: Math.max(0, startLine - 1) } },
    );
  }
}

/** The leaf note name, shown on that file's diff card. */
function leafName(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

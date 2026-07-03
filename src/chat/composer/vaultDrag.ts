import { normalizePath } from "obsidian";
import type { App, TFile } from "obsidian";

/**
 * Obsidian tracks the source of an in-app drag (e.g. a file dragged out of the
 * file explorer) on `app.dragManager.draggable`, but omits both from its published
 * TypeScript definitions. Declaring the shape once keeps the cast in a single place.
 * A single-file drag exposes `file`; a multi-selection drag exposes `files`.
 */
interface ObsidianDraggable {
  file?: unknown;
  files?: unknown[];
}

interface AppWithDragManager extends App {
  dragManager?: { draggable: ObsidianDraggable | null };
}

/** Extensions we treat as attachable text notes. */
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);

/**
 * Resolve an arbitrary vault path to a markdown TFile, or null. Resolving against the
 * vault (rather than trusting `instanceof TFile` on the drag payload) keeps this robust
 * across Obsidian versions and guarantees a real, current file reference.
 */
function toMarkdownFile(app: App, rawPath: string): TFile | null {
  const file = app.vault.getFileByPath(normalizePath(rawPath));
  return file && MARKDOWN_EXTENSIONS.has(file.extension) ? file : null;
}

function dedupeByPath(files: TFile[]): TFile[] {
  const seen = new Set<string>();
  const out: TFile[] = [];
  for (const file of files) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    out.push(file);
  }
  return out;
}

/**
 * Markdown notes carried by Obsidian's drag manager (vault file explorer), or an empty
 * list when the drag is not an in-app file drag. Readable during `dragover` (the manager
 * is populated for the whole drag), so it also drives the drop-target highlight.
 */
export function getDraggedVaultMarkdownFiles(app: App): TFile[] {
  const draggable = (app as AppWithDragManager).dragManager?.draggable;
  if (!draggable) return [];

  const candidates: unknown[] = [];
  if (Array.isArray(draggable.files)) candidates.push(...draggable.files);
  if (draggable.file) candidates.push(draggable.file);

  const files: TFile[] = [];
  for (const candidate of candidates) {
    const path = (candidate as { path?: unknown }).path;
    if (typeof path !== "string") continue;
    const file = toMarkdownFile(app, path);
    if (file) files.push(file);
  }
  return dedupeByPath(files);
}

function safeGetData(dt: DataTransfer, type: string): string {
  // getData throws in some contexts (and returns "" during dragover by spec); never let
  // a read failure abort the drop.
  try {
    return dt.getData(type);
  } catch {
    return "";
  }
}

/** Resolve one drag payload line (a path, a wikilink, or an obsidian:// URL) to a note. */
function resolveDragLine(app: App, line: string): TFile | null {
  let candidate = line.trim();
  if (!candidate) return null;

  if (candidate.startsWith("obsidian://")) {
    try {
      const fileParam = new URL(candidate).searchParams.get("file");
      if (!fileParam) return null;
      candidate = fileParam;
    } catch {
      return null;
    }
  }

  // Strip a surrounding wikilink, keeping only the link target (before | alias or # heading).
  const wiki = candidate.match(/^\[\[([^\]|#]+)/);
  const linktext = (wiki ? wiki[1] : candidate).trim();

  // Try a direct vault path first, then Obsidian's link resolver (handles bare basenames).
  const direct = toMarkdownFile(app, linktext);
  if (direct) return direct;
  const dest = app.metadataCache.getFirstLinkpathDest(linktext, "");
  return dest && MARKDOWN_EXTENSIONS.has(dest.extension) ? dest : null;
}

/** Notes referenced by a drop's dataTransfer text (fallback when the drag manager is empty). */
function markdownFilesFromDataTransfer(app: App, dt: DataTransfer): TFile[] {
  const raw = safeGetData(dt, "text/plain") || safeGetData(dt, "text/uri-list");
  if (!raw) return [];
  const files: TFile[] = [];
  for (const line of raw.split(/[\r\n]+/)) {
    const file = resolveDragLine(app, line);
    if (file) files.push(file);
  }
  return files;
}

/**
 * Vault markdown notes for a completed drop. Prefers the drag manager (populated for
 * file-explorer drags) and falls back to the drop's dataTransfer text (the wikilink /
 * obsidian:// URL Obsidian also writes), so the drop lands even if the manager was cleared.
 */
export function getDroppedVaultMarkdownFiles(app: App, event: DragEvent): TFile[] {
  const fromManager = getDraggedVaultMarkdownFiles(app);
  if (fromManager.length > 0) return fromManager;
  return event.dataTransfer
    ? dedupeByPath(markdownFilesFromDataTransfer(app, event.dataTransfer))
    : [];
}

/** Whether an OS-dropped file is a markdown note we can read into context. */
export function isMarkdownDropFile(file: Pick<File, "name" | "type">): boolean {
  const name = file.name.toLowerCase();
  return (
    name.endsWith(".md") ||
    name.endsWith(".markdown") ||
    file.type === "text/markdown"
  );
}

import type { App, TFile } from "obsidian";
import type { Attachment, ImageAttachment, NoteAttachment } from "../shared/types";
import type { ExtraContextItem } from "../shared/chatRequest";
import { generateId } from "../utils";
import { truncateNoteText } from "./noteContext";
import { resolveNoteImageContext } from "./noteImageContext";

export interface SnapshotNoteOptions {
  /** Whether the active note should be captured. */
  activeNoteAttached: boolean;
  /** Extra vault notes manually attached via the context picker. */
  extraContextItems: ExtraContextItem[];
  /** Character budget per note before truncation. */
  maxContextChars: number;
  /** Resolve embedded images into frozen image attachments (vision models only). */
  includeImages: boolean;
}

/**
 * Snapshot the attached notes (active note + picked notes) into frozen
 * attachments at send time. Note text becomes a `NoteAttachment`; any embedded
 * images become `ImageAttachment`s tagged with `sourceNotePath` so they share
 * the note's one-shot lifecycle instead of being re-resolved live each turn.
 *
 * Returns a flat attachment list ready to merge onto the user message.
 */
export async function snapshotNoteAttachments(
  app: App,
  options: SnapshotNoteOptions,
): Promise<Attachment[]> {
  const { activeNoteAttached, extraContextItems, maxContextChars, includeImages } = options;

  const notes: NoteAttachment[] = [];
  const imageSources: Array<{ file: TFile; rawContent: string }> = [];

  if (activeNoteAttached) {
    const file = app.workspace.getActiveFile();
    if (file) {
      const raw = await app.vault.read(file);
      notes.push(makeNoteAttachment(file.path, file.basename, raw, file.stat.mtime, maxContextChars));
      if (includeImages) imageSources.push({ file, rawContent: raw });
    }
  }

  for (const item of extraContextItems) {
    // External file (dragged from the OS file system): its content was captured at
    // drop time and has no vault file to re-read or resolve embedded images from.
    if (item.content !== undefined) {
      notes.push(makeNoteAttachment(item.filePath, item.fileName, item.content, 0, maxContextChars));
      continue;
    }
    const file = app.vault.getFileByPath(item.filePath);
    if (!file) continue;
    const raw = await app.vault.read(file);
    notes.push(makeNoteAttachment(file.path, item.fileName, raw, file.stat.mtime, maxContextChars));
    if (includeImages) imageSources.push({ file, rawContent: raw });
  }

  const images = includeImages && imageSources.length > 0
    ? (await resolveNoteImageContext(app, imageSources)).map(toImageAttachment)
    : [];

  return [...notes, ...images];
}

function makeNoteAttachment(
  filePath: string,
  fileName: string,
  raw: string,
  mtimeSnapshot: number,
  maxContextChars: number,
): NoteAttachment {
  return {
    type: "note",
    id: generateId(),
    filePath,
    fileName,
    content: truncateNoteText(raw, maxContextChars),
    truncated: raw.length > maxContextChars,
    mtimeSnapshot,
  };
}

function toImageAttachment(item: {
  noteFilePath: string;
  fileName: string;
  mimeType: ImageAttachment["mimeType"];
  data: string;
}): ImageAttachment {
  return {
    type: "image",
    id: generateId(),
    mimeType: item.mimeType,
    data: item.data,
    fileName: item.fileName,
    sourceNotePath: item.noteFilePath,
  };
}

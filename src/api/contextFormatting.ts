import type { NoteAttachment } from "../shared/types";
import type { AdditionalContextItem, DocumentContext } from "../shared/chatRequest";

/**
 * Labeled text for context that belongs in the conversation, never the cached
 * system prefix. Note snapshots ride their own (frozen) user turn; the live
 * edit-mode document and extra notes are appended to the latest user turn.
 * Shared across all provider clients so placement and labels stay consistent.
 */

/** A frozen note snapshot attached to a user turn (chat/plan mode). */
export function formatNoteAttachment(note: NoteAttachment): string {
  return `---\nAttached note (${note.filePath}):\n${note.content}`;
}

/** The live document under edit (edit mode), re-sent each turn. */
export function formatDocumentContext(doc: DocumentContext): string {
  const label = doc.isFull
    ? `Document to edit (${doc.filePath})`
    : `Current note (${doc.filePath})`;
  return `---\n${label}:\n${doc.content}`;
}

/** A live extra context note (edit mode). */
export function formatAdditionalContextItem(item: AdditionalContextItem): string {
  return `---\nContext note (${item.filePath}):\n${item.content}`;
}

/** Provenance label for an image embedded in an attached note. */
export function noteImageLabel(sourceNotePath: string, fileName: string): string {
  return `Embedded image from attached note (${sourceNotePath}): ${fileName}`;
}

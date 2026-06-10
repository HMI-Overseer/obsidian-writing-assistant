import type { Message, OpenAIContentPart } from "../shared/types";
import type { NoteImageContextItem } from "../shared/chatRequest";

/**
 * Helpers for mutating OpenAI-format chat messages, shared by every client
 * that speaks the OpenAI wire format (OpenAI, LM Studio).
 */

/**
 * Appends a text segment to an OpenAI-format user message, handling both
 * plain-string and multipart content-array formats.
 */
export function appendTextToOpenAIMessage(message: Message, text: string): void {
  if (typeof message.content === "string") {
    message.content = message.content + "\n\n" + text;
  } else if (Array.isArray(message.content)) {
    (message.content as OpenAIContentPart[]).push({ type: "text", text });
  }
}

/**
 * Appends resolved note-embedded images to an OpenAI-format user message,
 * labeling each image with its source note so the model can attribute it.
 */
export function appendNoteImageContextToOpenAIMessage(
  message: Message,
  images: NoteImageContextItem[],
): void {
  const parts = ensureOpenAIUserParts(message);
  for (const image of images) {
    parts.push({
      type: "text",
      text: `Embedded image from attached note (${image.noteFilePath}): ${image.fileName}`,
    });
    parts.push({
      type: "image_url",
      image_url: { url: `data:${image.mimeType};base64,${image.data}` },
    });
  }
}

/** Converts a plain-string message to multipart form and returns its parts. */
function ensureOpenAIUserParts(message: Message): OpenAIContentPart[] {
  if (Array.isArray(message.content)) {
    return message.content as OpenAIContentPart[];
  }
  const parts: OpenAIContentPart[] = [];
  if (typeof message.content === "string" && message.content) {
    parts.push({ type: "text", text: message.content });
  }
  message.content = parts;
  return parts;
}

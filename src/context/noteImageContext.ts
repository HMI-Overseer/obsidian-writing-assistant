import type { App, TFile } from "obsidian";
import {
  MAX_NOTE_CONTEXT_IMAGES,
  MAX_NOTE_CONTEXT_IMAGE_SIZE_BYTES,
  MAX_NOTE_CONTEXT_TOTAL_BYTES,
  SUPPORTED_IMAGE_MIME_BY_EXTENSION,
} from "../constants";
import type { NoteImageContextItem } from "../shared/chatRequest";

interface NoteImageSource {
  file: TFile;
  rawContent: string;
}

type NoteImageRef = { target: string };

const EMBED_RE = /!\[\[([^\]]+)\]\]/g;

export async function resolveNoteImageContext(
  app: App,
  sources: NoteImageSource[],
): Promise<NoteImageContextItem[]> {
  const results: NoteImageContextItem[] = [];
  const seenImagePaths = new Set<string>();
  let totalBytes = 0;

  for (const source of sources) {
    const refs = extractEmbeddedImageRefs(source.rawContent);
    for (const ref of refs) {
      if (results.length >= MAX_NOTE_CONTEXT_IMAGES) {
        return results;
      }

      const imageFile = resolveEmbeddedImageFile(app, source.file, ref);
      if (!imageFile || seenImagePaths.has(imageFile.path)) continue;

      const mimeType = getImageMimeType(imageFile);
      if (!mimeType) continue;

      const binary = await app.vault.readBinary(imageFile);
      if (binary.byteLength > MAX_NOTE_CONTEXT_IMAGE_SIZE_BYTES) continue;
      if (totalBytes + binary.byteLength > MAX_NOTE_CONTEXT_TOTAL_BYTES) continue;

      results.push({
        noteFilePath: source.file.path,
        imageFilePath: imageFile.path,
        fileName: imageFile.name,
        mimeType,
        data: arrayBufferToBase64(binary),
      });
      seenImagePaths.add(imageFile.path);
      totalBytes += binary.byteLength;
    }
  }

  return results;
}

export function extractEmbeddedImageRefs(rawContent: string): NoteImageRef[] {
  const refs: NoteImageRef[] = [];

  for (const match of rawContent.matchAll(EMBED_RE)) {
    const wikiTarget = match[1]?.trim();
    if (!wikiTarget) continue;
    const target = wikiTarget.split("|", 1)[0]?.split("#", 1)[0]?.trim();
    if (target) refs.push({ target });
  }

  return refs;
}

function resolveEmbeddedImageFile(app: App, sourceFile: TFile, ref: NoteImageRef): TFile | null {
  const file = app.metadataCache.getFirstLinkpathDest(ref.target, sourceFile.path);
  return file && getImageMimeType(file) ? file : null;
}

function getImageMimeType(file: TFile): NoteImageContextItem["mimeType"] | null {
  return SUPPORTED_IMAGE_MIME_BY_EXTENSION[file.extension.toLowerCase()] ?? null;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

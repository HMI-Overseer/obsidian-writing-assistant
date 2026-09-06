import { Notice, type App, type TFile } from "obsidian";
import {
  MAX_NOTE_CONTEXT_IMAGES,
  MAX_NOTE_CONTEXT_IMAGE_SIZE_BYTES,
  MAX_NOTE_CONTEXT_TOTAL_BYTES,
  SUPPORTED_IMAGE_MIME_BY_EXTENSION,
} from "../constants";
import type { NoteImageContextItem } from "../shared/chatRequest";
import { arrayBufferToBase64 } from "../utils";

interface NoteImageSource {
  file: TFile;
  rawContent: string;
}

type NoteImageRef = { target: string };

// Matches Obsidian wikilink embeds (![[image.png]]) and standard markdown
// image embeds (![alt](path)). Remote URLs are filtered out during extraction;
// both forms resolve exclusively through metadataCache so paths can never
// escape the vault.
const EMBED_RE = /!\[\[([^\]]+)\]\]|!\[[^\]]*\]\(([^)\n]+)\)/g;
const REMOTE_URL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

// Skipped images are reported once per path so repeated sends in the same
// session don't spam notices.
const notifiedSkippedPaths = new Set<string>();

export async function resolveNoteImageContext(
  app: App,
  sources: NoteImageSource[],
): Promise<NoteImageContextItem[]> {
  const results: NoteImageContextItem[] = [];
  const seenImagePaths = new Set<string>();
  const skipped: string[] = [];
  let totalBytes = 0;

  for (const source of sources) {
    const refs = extractEmbeddedImageRefs(source.rawContent);
    for (const ref of refs) {
      const imageFile = resolveEmbeddedImageFile(app, source.file, ref);
      if (!imageFile || seenImagePaths.has(imageFile.path)) continue;

      const mimeType = getImageMimeType(imageFile);
      if (!mimeType) continue;

      if (results.length >= MAX_NOTE_CONTEXT_IMAGES) {
        skipped.push(`${imageFile.name} (image limit reached)`);
        seenImagePaths.add(imageFile.path);
        continue;
      }

      const binary = await app.vault.readBinary(imageFile);
      if (binary.byteLength > MAX_NOTE_CONTEXT_IMAGE_SIZE_BYTES) {
        skipped.push(`${imageFile.name} (too large)`);
        seenImagePaths.add(imageFile.path);
        continue;
      }
      if (totalBytes + binary.byteLength > MAX_NOTE_CONTEXT_TOTAL_BYTES) {
        skipped.push(`${imageFile.name} (total size budget reached)`);
        seenImagePaths.add(imageFile.path);
        continue;
      }

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

  notifySkippedImages(skipped);
  return results;
}

export function extractEmbeddedImageRefs(rawContent: string): NoteImageRef[] {
  const refs: NoteImageRef[] = [];

  for (const match of rawContent.matchAll(EMBED_RE)) {
    const wikiTarget = match[1]?.trim();
    if (wikiTarget) {
      const target = wikiTarget.split("|", 1)[0]?.split("#", 1)[0]?.trim();
      if (target) refs.push({ target });
      continue;
    }

    const markdownTarget = normalizeMarkdownTarget(match[2]);
    if (markdownTarget) refs.push({ target: markdownTarget });
  }

  return refs;
}

/**
 * Reduce a markdown embed target to a vault-relative link path, or null when
 * the target is remote or empty. The result is only ever resolved through
 * metadataCache.getFirstLinkpathDest, never used as a raw filesystem path.
 */
function normalizeMarkdownTarget(rawTarget: string | undefined): string | null {
  const unwrapped = unwrapAngleBrackets(rawTarget?.trim() ?? "");
  if (!unwrapped) return null;

  const href = safeDecodeUri(unwrapped);
  if (!href || REMOTE_URL_RE.test(href)) return null;

  const pathOnly = href.split(/[?#]/, 1)[0]?.replace(/^\/+/, "").trim();
  return pathOnly || null;
}

function resolveEmbeddedImageFile(app: App, sourceFile: TFile, ref: NoteImageRef): TFile | null {
  const file = app.metadataCache.getFirstLinkpathDest(ref.target, sourceFile.path);
  return file && getImageMimeType(file) ? file : null;
}

function getImageMimeType(file: TFile): NoteImageContextItem["mimeType"] | null {
  return SUPPORTED_IMAGE_MIME_BY_EXTENSION[file.extension.toLowerCase()] ?? null;
}

function notifySkippedImages(skipped: string[]): void {
  const fresh = skipped.filter((entry) => !notifiedSkippedPaths.has(entry));
  if (fresh.length === 0) return;

  for (const entry of fresh) notifiedSkippedPaths.add(entry);

  const detail = fresh.length <= 3
    ? fresh.join(", ")
    : `${fresh.slice(0, 3).join(", ")} and ${fresh.length - 3} more`;
  new Notice(`Some embedded images were not sent to the model: ${detail}`);
}

function unwrapAngleBrackets(value: string): string {
  return value.startsWith("<") && value.endsWith(">")
    ? value.slice(1, -1)
    : value;
}

function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

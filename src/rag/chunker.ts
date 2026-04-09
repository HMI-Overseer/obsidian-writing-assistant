import type { DocumentChunk, EmbeddingMetadata } from "./types";

/**
 * Preprocess raw markdown content before chunking and embedding.
 * Strips syntax that pollutes the embedding space while preserving
 * semantically meaningful text. Code blocks are left intact.
 */
export function preprocessMarkdown(content: string): string {
  // 1. Protect code blocks from being mangled by later regexes.
  //    Replace them with placeholders, then restore after cleaning.
  const codeBlocks: string[] = [];
  const PLACEHOLDER_PREFIX = "%%CODEBLOCK_";
  const PLACEHOLDER_SUFFIX = "%%";
  let processed = content.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `${PLACEHOLDER_PREFIX}${codeBlocks.length - 1}${PLACEHOLDER_SUFFIX}`;
  });

  // 2. Strip YAML frontmatter (must be at the very start of the file).
  processed = processed.replace(/^---\n[\s\S]*?\n---\n?/, "");

  // 3. Remove image embeds: ![[image.png]] and ![alt](url)
  processed = processed.replace(/!\[\[.*?\]\]/g, "");
  processed = processed.replace(/!\[.*?\]\(.*?\)/g, "");

  // 4. Resolve wikilinks: [[Note|Display]] → Display, [[Note]] → Note
  processed = processed.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2");
  processed = processed.replace(/\[\[([^\]]+)\]\]/g, "$1");

  // 5. Strip markdown links: [text](url) → text
  processed = processed.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // 6. Clean tag syntax: #tag/subtag → tag subtag
  //    Only match tags at word boundaries, not inside headings.
  processed = processed.replace(/(?<=^|\s)#([a-zA-Z][\w/]*)/gm, (_, tag: string) =>
    tag.replace(/\//g, " "),
  );

  // 7. Restore code blocks.
  const placeholderRe = new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`, "g");
  processed = processed.replace(placeholderRe, (_, idx) => codeBlocks[Number(idx)]);

  return processed;
}

/** Minimum chunk size in characters. Smaller chunks are merged with neighbors. */
const MIN_CHUNK_CHARS = 50;

/** Regex matching markdown heading lines (# through ######). */
const HEADING_RE = /^(#{1,6})\s+(.+)$/;

interface HeadingNode {
  level: number;
  title: string;
  /** Character offset where this section starts (including the heading line). */
  startOffset: number;
  /** The text body under this heading (excluding child headings). */
  body: string;
}

/**
 * Chunk a markdown document into retrieval-friendly pieces.
 *
 * Strategy:
 * 1. Split on headings to produce semantic sections.
 * 2. Sections exceeding `chunkSize` are further split at paragraph boundaries.
 * 3. Paragraph-split chunks include `chunkOverlap` chars from the previous chunk.
 * 4. Chunks under `MIN_CHUNK_CHARS` are merged with the previous chunk.
 */
export function chunkDocument(
  filePath: string,
  content: string,
  chunkSize: number,
  chunkOverlap: number,
): DocumentChunk[] {
  if (!content.trim()) return [];

  const sections = splitByHeadings(content);
  const rawChunks: DocumentChunk[] = [];
  let chunkIndex = 0;

  for (const section of sections) {
    const headingPath = section.title;
    const pieces = splitSection(section.body, chunkSize, chunkOverlap);

    let offset = section.startOffset;
    for (const piece of pieces) {
      rawChunks.push({
        id: `${filePath}::${chunkIndex}`,
        filePath,
        headingPath,
        content: piece,
        startOffset: offset,
        chunkIndex,
      });
      offset += piece.length;
      chunkIndex++;
    }
  }

  return mergeSmallChunks(rawChunks);
}

/**
 * Split document text into sections by markdown headings.
 * Returns a flat list with heading breadcrumb paths.
 */
function splitByHeadings(content: string): HeadingNode[] {
  const lines = content.split("\n");
  const sections: HeadingNode[] = [];

  // Track the heading stack for breadcrumb building.
  const headingStack: Array<{ level: number; title: string }> = [];
  let currentBody = "";
  let currentOffset = 0;
  let sectionStartOffset = 0;

  for (const line of lines) {
    const match = HEADING_RE.exec(line);

    if (match) {
      // Flush the previous section.
      if (currentBody || sections.length === 0) {
        sections.push({
          level: headingStack.length > 0 ? headingStack[headingStack.length - 1].level : 0,
          title: buildBreadcrumb(headingStack),
          startOffset: sectionStartOffset,
          body: currentBody,
        });
      }

      const level = match[1].length;
      const title = match[2].trim();

      // Pop stack entries at same or lower level.
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, title });

      currentBody = "";
      sectionStartOffset = currentOffset;
    } else {
      if (currentBody) {
        currentBody += "\n" + line;
      } else {
        currentBody = line;
      }
    }

    currentOffset += line.length + 1; // +1 for newline
  }

  // Flush last section.
  if (currentBody.trim()) {
    sections.push({
      level: headingStack.length > 0 ? headingStack[headingStack.length - 1].level : 0,
      title: buildBreadcrumb(headingStack),
      startOffset: sectionStartOffset,
      body: currentBody,
    });
  }

  // Filter out empty body sections (heading-only sections with no text).
  return sections.filter((s) => s.body.trim().length > 0);
}

function buildBreadcrumb(stack: Array<{ level: number; title: string }>): string {
  if (stack.length === 0) return "";
  return stack.map((h) => h.title).join(" > ");
}

/**
 * Split a section body into chunks respecting `chunkSize`.
 * Splits at paragraph boundaries (`\n\n`), with overlap.
 */
function splitSection(text: string, chunkSize: number, chunkOverlap: number): string[] {
  if (text.length <= chunkSize) return [text];

  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    const candidate = current ? current + "\n\n" + para : para;

    if (candidate.length > chunkSize && current) {
      chunks.push(current);

      // Start next chunk with overlap from the end of the previous.
      const overlap = chunkOverlap > 0 ? current.slice(-chunkOverlap) : "";
      current = overlap ? overlap + "\n\n" + para : para;
    } else {
      current = candidate;
    }
  }

  if (current.trim()) {
    chunks.push(current);
  }

  // If paragraph-level splitting wasn't enough (single huge paragraph),
  // fall back to hard character splitting.
  return chunks.flatMap((chunk) =>
    chunk.length > chunkSize * 2 ? hardSplit(chunk, chunkSize, chunkOverlap) : [chunk],
  );
}

/** Hard character-boundary split as last resort for very long paragraphs. */
function hardSplit(text: string, chunkSize: number, chunkOverlap: number): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    start = end - chunkOverlap;
    if (start >= text.length) break;
    // Prevent infinite loop if overlap >= chunkSize.
    if (end === text.length) break;
  }

  return chunks;
}

/** Merge chunks smaller than MIN_CHUNK_CHARS into the previous chunk. */
function mergeSmallChunks(chunks: DocumentChunk[]): DocumentChunk[] {
  if (chunks.length <= 1) return chunks;

  const result: DocumentChunk[] = [chunks[0]];

  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i];
    const prev = result[result.length - 1];

    if (chunk.content.trim().length < MIN_CHUNK_CHARS) {
      // Merge into previous chunk.
      prev.content = prev.content + "\n\n" + chunk.content;
    } else {
      result.push(chunk);
    }
  }

  // Re-index after merging.
  for (let i = 0; i < result.length; i++) {
    result[i].chunkIndex = i;
    result[i].id = `${result[i].filePath}::${i}`;
  }

  return result;
}

/**
 * Extract wikilink targets from raw markdown content.
 * Returns deduplicated link targets (the note name, not the display alias).
 * Must be called BEFORE `preprocessMarkdown()` which strips wikilinks.
 */
export function extractWikilinks(rawContent: string): string[] {
  const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  const links = new Set<string>();
  let match;
  while ((match = re.exec(rawContent)) !== null) {
    const target = match[1].trim();
    if (target) links.add(target);
  }
  return [...links];
}

/**
 * Extract the parent folder path from a vault file path.
 * Returns an empty string for root-level files.
 */
export function extractFolder(filePath: string): string {
  const lastSlash = filePath.lastIndexOf("/");
  return lastSlash > 0 ? filePath.slice(0, lastSlash) : "";
}

/**
 * Build the text sent to the embedding model for a chunk.
 * Prepends metadata signals (tags, folder, links) and the note title / heading
 * breadcrumb so the embedding vector captures *where* in the vault this chunk
 * lives and *what entities it references* — not just its prose content.
 *
 * The stored `content` field is NOT modified; only the embedding input changes.
 */
export function buildEmbeddingText(chunk: DocumentChunk, meta?: EmbeddingMetadata): string {
  const lines: string[] = [];

  // Metadata prefix lines — only include non-empty signals.
  if (meta?.tags?.length) lines.push(`[Tags: ${meta.tags.join(", ")}]`);
  if (meta?.folder) lines.push(`[Folder: ${meta.folder}]`);
  if (meta?.links?.length) lines.push(`[Links: ${meta.links.join(", ")}]`);

  // Note title + heading breadcrumb.
  const fileName = chunk.filePath.replace(/\.md$/, "").split("/").pop() ?? "";
  const breadcrumbParts: string[] = [];
  if (fileName) breadcrumbParts.push(fileName);
  if (chunk.headingPath) breadcrumbParts.push(chunk.headingPath);
  if (breadcrumbParts.length > 0) lines.push(breadcrumbParts.join(" > "));

  // Chunk content.
  lines.push(chunk.content);

  return lines.join("\n");
}

/**
 * FNV-1a hash of a string, returned as a hex string.
 * Used for fast content change detection in incremental indexing.
 */
export function fnv1aHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

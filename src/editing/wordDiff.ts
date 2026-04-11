/** A segment of text that may or may not be highlighted (changed). */
export interface DiffSegment {
  text: string;
  highlighted: boolean;
}

export interface WordDiffResult {
  removed: DiffSegment[];
  added: DiffSegment[];
}

/**
 * Compute word-level diff between two lines. Splits on word boundaries,
 * finds the longest common prefix and suffix of tokens, and highlights
 * the changed middle segment.
 */
export function computeWordDiff(oldLine: string, newLine: string): WordDiffResult {
  if (oldLine === newLine) {
    return {
      removed: [{ text: oldLine, highlighted: false }],
      added: [{ text: newLine, highlighted: false }],
    };
  }

  const oldTokens = tokenize(oldLine);
  const newTokens = tokenize(newLine);

  // Find common prefix tokens
  let prefixLen = 0;
  while (
    prefixLen < oldTokens.length &&
    prefixLen < newTokens.length &&
    oldTokens[prefixLen] === newTokens[prefixLen]
  ) {
    prefixLen++;
  }

  // Find common suffix tokens (not overlapping with prefix)
  let suffixLen = 0;
  while (
    suffixLen < oldTokens.length - prefixLen &&
    suffixLen < newTokens.length - prefixLen &&
    oldTokens[oldTokens.length - 1 - suffixLen] === newTokens[newTokens.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const commonPrefix = oldTokens.slice(0, prefixLen).join("");
  const commonSuffix = oldTokens.slice(oldTokens.length - suffixLen).join("");
  const oldMiddle = oldTokens.slice(prefixLen, oldTokens.length - suffixLen).join("");
  const newMiddle = newTokens.slice(prefixLen, newTokens.length - suffixLen).join("");

  return {
    removed: buildSegments(commonPrefix, oldMiddle, commonSuffix),
    added: buildSegments(commonPrefix, newMiddle, commonSuffix),
  };
}

/** Split text into tokens at word boundaries, preserving whitespace as separate tokens. */
export function tokenize(text: string): string[] {
  return text.match(/\S+|\s+/g) ?? [text];
}

export function buildSegments(prefix: string, middle: string, suffix: string): DiffSegment[] {
  const segments: DiffSegment[] = [];
  if (prefix) segments.push({ text: prefix, highlighted: false });
  if (middle) segments.push({ text: middle, highlighted: true });
  if (suffix) segments.push({ text: suffix, highlighted: false });
  return segments;
}

/** Render segments into a text element, highlighting changed portions. */
export function renderSegments(textEl: HTMLElement, segments: DiffSegment[]): void {
  const hasContent = segments.some((s) => s.text.length > 0);
  if (!hasContent) {
    textEl.setText(" ");
    return;
  }
  for (const segment of segments) {
    if (segment.text.length === 0) continue;
    if (segment.highlighted) {
      const span = textEl.createSpan({ cls: "lmsa-chat-window-diff-highlight" });
      span.setText(segment.text);
    } else {
      textEl.appendText(segment.text);
    }
  }
}

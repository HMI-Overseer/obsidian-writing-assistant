/** One editable surface in an inline edit session. */
export interface InlineEditTarget {
  /**
   * The prose item this surface belongs to. Absent for a session over a single
   * undivided surface: a user message, or a legacy assistant revision whose
   * stored content has no item identity.
   */
  proseItemId?: string;
  originalText: string;
}

/** One surface whose text the writer actually changed. */
export interface InlineEdit {
  proseItemId?: string;
  text: string;
}

/**
 * Reduce an edit session's raw textarea values to the edits worth committing.
 *
 * A blank value counts as unchanged rather than as a deletion, so clearing a
 * block and saving leaves it alone instead of destroying it. An empty result
 * means the session had nothing to commit and should cancel.
 */
export function collectInlineEdits(
  targets: readonly InlineEditTarget[],
  values: readonly string[],
): InlineEdit[] {
  const edits: InlineEdit[] = [];
  targets.forEach((target, index) => {
    const text = values[index]?.trim() ?? "";
    if (!text || text === target.originalText) return;
    edits.push({
      ...(target.proseItemId === undefined
        ? {}
        : { proseItemId: target.proseItemId }),
      text,
    });
  });
  return edits;
}

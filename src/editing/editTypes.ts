/** A raw search/replace block parsed from model output. */
export interface EditBlock {
  id: string;
  searchText: string;
  replaceText: string;
  rawBlock: string;
  /**
   * Vault-relative path of the note this edit targets, from the tool call's `path`
   * argument. Absent for regex-parsed blocks (which target the active document).
   */
  targetPath?: string;
  /** For structure-aware tools, the originating tool name. */
  toolName?: "update_frontmatter";
  /** Tool-specific arguments needed for resolution (e.g., heading text, line number). */
  toolArgs?: Record<string, unknown>;
}

/**
 * How an edit's search text matched the document, in plain words the model can read
 * directly (not tier numbers or confidence values):
 *   - `exact`, found verbatim.
 *   - `whitespace`, same text, only spacing/indentation differed.
 *   - `fuzzy`, close but not identical (the model was sloppy).
 *   - `none`, nothing matched.
 * Mirrors the three resolver tiers in {@link ./diffEngine.resolveEdits}; `fuzzy`/
 * `whitespace`/`exact` only occur on a match, `none` only on a miss.
 */
export type MatchType = "exact" | "whitespace" | "fuzzy" | "none";

/** An EditBlock resolved against the actual document content. */
export interface ResolvedEdit {
  id: string;
  editBlock: EditBlock;
  /** Character offset in the original document where the match starts. */
  matchOffset: number;
  /** Character length of the matched region (may differ from searchText for fuzzy). */
  matchLength: number;
  /** The actual text that was matched in the document. */
  matchedText: string;
  /** 1-indexed start line of the match. */
  startLine: number;
  /** 1-indexed end line of the match (inclusive). */
  endLine: number;
  /** Context lines before the match region. */
  contextBefore: string[];
  /** Context lines after the match region. */
  contextAfter: string[];
  /** Match confidence: 1.0 = exact, 0.95 = whitespace-normalized, lower = fuzzy. */
  confidence: number;
  /** Which resolver tier produced the match, in plain words ({@link MatchType}). */
  matchType: MatchType;
  /**
   * For a `none` match only: true when the closest sliding window was *similar* but
   * fell below the acceptance threshold, the "you were close, copy the exact wording"
   * signal vs "that text isn't here, re-read." Absent/false means no near candidate.
   */
  nearMiss?: boolean;
}

export type EditStatus = "pending" | "accepted" | "rejected";

/** A single reviewable change in the diff UI. */
export interface DiffHunk {
  id: string;
  resolvedEdit: ResolvedEdit;
  status: EditStatus;
}

/** The full edit proposal attached to an assistant message. */
export interface EditProposal {
  id: string;
  /** Vault-relative file path at the time of proposal. */
  targetFilePath: string;
  /** Full document content at time of proposal (for conflict detection). */
  documentSnapshot: string;
  /** Timestamp when the document snapshot was taken. */
  snapshotTimestamp: number;
  hunks: DiffHunk[];
  /** Model's explanatory text that was not part of edit blocks. */
  prose: string;
}

/** Persisted with the conversation message after edits are applied. */
export interface AppliedEditRecord {
  proposalId: string;
  targetFilePath: string;
  /** Document content before edits were applied. */
  preApplySnapshot: string;
  /** Document content after edits were applied. */
  postApplySnapshot: string;
  appliedAt: number;
  /** Which hunk IDs were actually applied. */
  appliedHunkIds: string[];
}

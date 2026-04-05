/** A raw search/replace block parsed from model output. */
export interface EditBlock {
  id: string;
  searchText: string;
  replaceText: string;
  rawBlock: string;
  /** For structure-aware tools, the originating tool name. */
  toolName?: "replace_section" | "insert_at_position" | "update_frontmatter";
  /** Tool-specific arguments needed for resolution (e.g., heading text, line number). */
  toolArgs?: Record<string, unknown>;
}

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

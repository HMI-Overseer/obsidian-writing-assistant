/** A chunk of a vault document, the unit of retrieval. */
export interface DocumentChunk {
  /** Stable ID: `${filePath}::${chunkIndex}` */
  id: string;
  filePath: string;
  /** Heading breadcrumb path, e.g. "Chapter 1 > Scene 3" */
  headingPath: string;
  /** The raw text of this chunk. */
  content: string;
  /** Character offset of chunk start within the original file. */
  startOffset: number;
  /** Sequential index within the file. */
  chunkIndex: number;
}

/** A chunk with its embedding vector stored. */
export interface IndexedChunk extends DocumentChunk {
  /** The embedding vector (Float32 values). */
  vector: number[];
}

/** File-level metadata for incremental indexing. */
export interface FileIndexMeta {
  filePath: string;
  /** Vault mtime at time of indexing. */
  mtime: number;
  /** Content hash at time of indexing (fast change detection). */
  contentHash: string;
  /** Number of chunks produced from this file. */
  chunkCount: number;
}

/**
 * Ephemeral metadata used to enrich embedding text at index time.
 * Not stored in the index — computed from vault state during indexing.
 */
export interface EmbeddingMetadata {
  /** Frontmatter tags from the file. */
  tags: string[];
  /** Parent folder path (e.g. "Books/Prequel/Characters"). */
  folder: string;
  /** Wikilink targets extracted from the raw file content. */
  links: string[];
}

/** A retrieval result returned to the caller. */
export interface RetrievalResult {
  chunk: DocumentChunk;
  score: number;
}

/** RAG-specific settings. */
export interface RagSettings {
  enabled: boolean;
  /** EmbeddingModel.id from the embeddingModels array. */
  activeEmbeddingModelId: string | null;
  /** Target chunk size in characters. */
  chunkSize: number;
  /** Overlap between chunks in characters. */
  chunkOverlap: number;
  /** Number of retrieval results to inject as context. */
  topK: number;
  /** Minimum similarity score (0–1) to include a result. */
  minScore: number;
  /** File patterns to exclude from indexing (glob strings). */
  excludePatterns: string[];
  /** Maximum total characters of RAG context to inject into a prompt. */
  maxContextChars: number;
  /** Enrich embedding text with tags, folder path, and wikilink targets for disambiguation. */
  metadataEnrichment: boolean;
}

/** Serialized index format written to disk. */
export interface SerializedVectorIndex {
  version: 1;
  embeddingModelId: string;
  dimensions: number;
  /** Chunk size used when the index was built. Used for settings drift detection. */
  chunkSize?: number;
  /** Chunk overlap used when the index was built. Used for settings drift detection. */
  chunkOverlap?: number;
  /** Whether the index was built with metadata-enriched embedding text (tags, folder, links). */
  metadataEnriched?: boolean;
  files: FileIndexMeta[];
  chunks: SerializedChunk[];
}

/** A chunk serialized for disk storage. */
export interface SerializedChunk {
  id: string;
  filePath: string;
  headingPath: string;
  content: string;
  startOffset: number;
  chunkIndex: number;
  /** Base64-encoded Float32Array. */
  vectorB64: string;
}

export type IndexingState =
  | { status: "idle" }
  | { status: "indexing"; filesProcessed: number; filesTotal: number }
  | { status: "error"; message: string };

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
  /** Whether to boost retrieval scores for notes linked from the active note. */
  graphBoostEnabled: boolean;
  /** Base strength of the graph boost (0–1). Tapers with link count. */
  graphBoostStrength: number;
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

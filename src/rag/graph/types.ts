/** Entity types that can be extracted from vault documents. */
export type EntityType = "character" | "location" | "object" | "concept" | "event";

/** An entity extracted from a vault document by the LLM. */
export interface GraphEntity {
  /** Canonical name (e.g. "Alice", "The Iron Castle"). */
  name: string;
  type: EntityType;
  /** Brief LLM-generated description. */
  description: string;
  /** Files this entity was extracted from. */
  sourceFiles: string[];
  /** Alternate names found across documents. */
  aliases: string[];
  /** Embedding of "name: description" — in-memory and persisted. Absent when no embedding model was configured at build time. */
  embedding?: number[];
}

/** A relationship between two entities. */
export interface GraphRelation {
  /** Source entity name. */
  source: string;
  /** Target entity name. */
  target: string;
  /** Freeform relation label (e.g. "allies with", "located in", "caused"). */
  type: string;
  /** Brief context describing this relationship. */
  description: string;
  /** File this relation was extracted from. */
  sourceFile: string;
  /** Incremented when the same relation is found in multiple files. */
  weight: number;
}

/** Per-file metadata for incremental graph extraction. */
export interface GraphFileMeta {
  filePath: string;
  /** Vault mtime at time of extraction. */
  mtime: number;
  /** Content hash at time of extraction (fast change detection). */
  contentHash: string;
}

/** Persisted knowledge graph format written to disk. */
export interface SerializedKnowledgeGraph {
  version: 1;
  /** Which completion model built this graph. */
  modelId: string;
  /** Which embedding model was used to generate entity vectors. Used to detect stale embeddings on load. */
  embeddingModelId?: string;
  /** Timestamp when the graph was last built. */
  builtAt: number;
  files: GraphFileMeta[];
  entities: GraphEntity[];
  relations: GraphRelation[];
}

/** Knowledge graph build state, mirroring IndexingState. */
export type GraphBuildState =
  | { status: "idle" }
  | { status: "extracting"; filesProcessed: number; filesTotal: number; targetFolder?: string }
  | { status: "error"; message: string };

/** Knowledge graph settings. */
export interface KnowledgeGraphSettings {
  enabled: boolean;
  /** CompletionModel.id — the chat model used for entity extraction. */
  activeCompletionModelId: string | null;
  /** EmbeddingModel.id — used to generate entity vectors at build time. When null, falls back to substring matching. */
  activeEmbeddingModelId: string | null;
  /** Glob patterns to exclude from graph extraction. */
  excludePatterns: string[];
}

/**
 * Raw extraction result from a single LLM call.
 * This is the JSON structure the extraction prompt asks the LLM to produce.
 */
export interface ExtractionResult {
  entities: { name: string; type: EntityType; description: string }[];
  relationships: {
    source: string;
    target: string;
    type: string;
    description: string;
  }[];
}

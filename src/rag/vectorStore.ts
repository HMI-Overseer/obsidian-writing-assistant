import type {
  IndexedChunk,
  FileIndexMeta,
  SerializedVectorIndex,
  SerializedChunk,
} from "./types";

/**
 * In-memory vector store with JSON serialization.
 *
 * Stores indexed chunks and file metadata. Pure logic — no Obsidian
 * dependency. Persistence (read/write to disk) is handled by the caller.
 */
export class VectorStore {
  private chunks: Map<string, IndexedChunk> = new Map();
  private fileMeta: Map<string, FileIndexMeta> = new Map();
  private embeddingModelId: string;
  private dimensions: number;
  private chunkSize: number;
  private chunkOverlap: number;

  constructor(embeddingModelId: string, dimensions: number = 0, chunkSize: number = 0, chunkOverlap: number = 0) {
    this.embeddingModelId = embeddingModelId;
    this.dimensions = dimensions;
    this.chunkSize = chunkSize;
    this.chunkOverlap = chunkOverlap;
  }

  getEmbeddingModelId(): string {
    return this.embeddingModelId;
  }

  getDimensions(): number {
    return this.dimensions;
  }

  getChunkSize(): number {
    return this.chunkSize;
  }

  getChunkOverlap(): number {
    return this.chunkOverlap;
  }

  getAllChunks(): IndexedChunk[] {
    return [...this.chunks.values()];
  }

  getChunkCount(): number {
    return this.chunks.size;
  }

  getFileCount(): number {
    return this.fileMeta.size;
  }

  getFileMeta(filePath: string): FileIndexMeta | undefined {
    return this.fileMeta.get(filePath);
  }

  getAllFileMeta(): FileIndexMeta[] {
    return [...this.fileMeta.values()];
  }

  /** Add or replace chunks for a file. Removes any existing chunks for that file first. */
  setFileChunks(filePath: string, chunks: IndexedChunk[], meta: FileIndexMeta): void {
    this.removeFile(filePath);

    for (const chunk of chunks) {
      this.chunks.set(chunk.id, chunk);
      if (this.dimensions === 0 && chunk.vector.length > 0) {
        this.dimensions = chunk.vector.length;
      }
    }

    this.fileMeta.set(filePath, meta);
  }

  /** Remove all chunks and metadata for a file. */
  removeFile(filePath: string): void {
    const meta = this.fileMeta.get(filePath);
    if (!meta) return;

    // Remove all chunks belonging to this file.
    for (const [id, chunk] of this.chunks) {
      if (chunk.filePath === filePath) {
        this.chunks.delete(id);
      }
    }

    this.fileMeta.delete(filePath);
  }

  /** Update file paths after a rename. */
  renameFile(oldPath: string, newPath: string): void {
    const meta = this.fileMeta.get(oldPath);
    if (!meta) return;

    // Collect and re-key chunks.
    const fileChunks: IndexedChunk[] = [];
    for (const [id, chunk] of this.chunks) {
      if (chunk.filePath === oldPath) {
        this.chunks.delete(id);
        const updated: IndexedChunk = {
          ...chunk,
          filePath: newPath,
          id: `${newPath}::${chunk.chunkIndex}`,
        };
        fileChunks.push(updated);
      }
    }

    for (const chunk of fileChunks) {
      this.chunks.set(chunk.id, chunk);
    }

    this.fileMeta.delete(oldPath);
    this.fileMeta.set(newPath, { ...meta, filePath: newPath });
  }

  /** Clear all data. */
  clear(): void {
    this.chunks.clear();
    this.fileMeta.clear();
    this.dimensions = 0;
    this.chunkSize = 0;
    this.chunkOverlap = 0;
  }

  /** Serialize the store to a JSON-compatible object. */
  serialize(): SerializedVectorIndex {
    const chunks: SerializedChunk[] = [];

    for (const chunk of this.chunks.values()) {
      chunks.push({
        id: chunk.id,
        filePath: chunk.filePath,
        headingPath: chunk.headingPath,
        content: chunk.content,
        startOffset: chunk.startOffset,
        chunkIndex: chunk.chunkIndex,
        vectorB64: vectorToBase64(chunk.vector),
      });
    }

    return {
      version: 1,
      embeddingModelId: this.embeddingModelId,
      dimensions: this.dimensions,
      chunkSize: this.chunkSize,
      chunkOverlap: this.chunkOverlap,
      files: [...this.fileMeta.values()],
      chunks,
    };
  }

  /** Deserialize a stored index into this store. Returns false if the model ID doesn't match. */
  deserialize(data: SerializedVectorIndex): boolean {
    if (data.embeddingModelId !== this.embeddingModelId) {
      return false;
    }

    this.dimensions = data.dimensions;
    this.chunkSize = data.chunkSize ?? 0;
    this.chunkOverlap = data.chunkOverlap ?? 0;
    this.chunks.clear();
    this.fileMeta.clear();

    for (const file of data.files) {
      this.fileMeta.set(file.filePath, file);
    }

    for (const chunk of data.chunks) {
      this.chunks.set(chunk.id, {
        id: chunk.id,
        filePath: chunk.filePath,
        headingPath: chunk.headingPath,
        content: chunk.content,
        startOffset: chunk.startOffset,
        chunkIndex: chunk.chunkIndex,
        vector: base64ToVector(chunk.vectorB64),
      });
    }

    return true;
  }
}

/** Encode a number[] as a base64 string via Float32Array. */
export function vectorToBase64(vector: number[]): string {
  const float32 = new Float32Array(vector);
  const bytes = new Uint8Array(float32.buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Decode a base64 string back to a number[]. */
export function base64ToVector(b64: string): number[] {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const float32 = new Float32Array(bytes.buffer);
  return Array.from(float32);
}

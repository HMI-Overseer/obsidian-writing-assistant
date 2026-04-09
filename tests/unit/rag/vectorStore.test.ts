import { describe, test, expect } from "vitest";
import { VectorStore, vectorToBase64, base64ToVector } from "../../../src/rag/vectorStore";
import type { IndexedChunk, FileIndexMeta } from "../../../src/rag/types";

function makeChunk(filePath: string, index: number, vector: number[]): IndexedChunk {
  return {
    id: `${filePath}::${index}`,
    filePath,
    headingPath: "Section",
    content: `Chunk ${index} of ${filePath}`,
    startOffset: index * 100,
    chunkIndex: index,
    vector,
  };
}

function makeMeta(filePath: string, chunkCount: number): FileIndexMeta {
  return {
    filePath,
    mtime: Date.now(),
    contentHash: "abc123",
    chunkCount,
  };
}

describe("VectorStore", () => {
  test("starts empty", () => {
    const store = new VectorStore("model-1");
    expect(store.getChunkCount()).toBe(0);
    expect(store.getFileCount()).toBe(0);
    expect(store.getAllChunks()).toEqual([]);
  });

  test("setFileChunks adds chunks and metadata", () => {
    const store = new VectorStore("model-1");
    const chunks = [makeChunk("a.md", 0, [1, 2, 3]), makeChunk("a.md", 1, [4, 5, 6])];
    const meta = makeMeta("a.md", 2);

    store.setFileChunks("a.md", chunks, meta);

    expect(store.getChunkCount()).toBe(2);
    expect(store.getFileCount()).toBe(1);
    expect(store.getFileMeta("a.md")).toEqual(meta);
  });

  test("setFileChunks replaces existing chunks for same file", () => {
    const store = new VectorStore("model-1");
    store.setFileChunks("a.md", [makeChunk("a.md", 0, [1, 2, 3])], makeMeta("a.md", 1));
    store.setFileChunks("a.md", [makeChunk("a.md", 0, [7, 8, 9])], makeMeta("a.md", 1));

    expect(store.getChunkCount()).toBe(1);
    expect(store.getAllChunks()[0].vector).toEqual([7, 8, 9]);
  });

  test("removeFile clears chunks and metadata", () => {
    const store = new VectorStore("model-1");
    store.setFileChunks("a.md", [makeChunk("a.md", 0, [1, 2, 3])], makeMeta("a.md", 1));
    store.removeFile("a.md");

    expect(store.getChunkCount()).toBe(0);
    expect(store.getFileCount()).toBe(0);
    expect(store.getFileMeta("a.md")).toBeUndefined();
  });

  test("renameFile updates paths and chunk IDs", () => {
    const store = new VectorStore("model-1");
    store.setFileChunks("old.md", [makeChunk("old.md", 0, [1, 2, 3])], makeMeta("old.md", 1));
    store.renameFile("old.md", "new.md");

    expect(store.getFileMeta("old.md")).toBeUndefined();
    expect(store.getFileMeta("new.md")).toBeDefined();
    expect(store.getAllChunks()[0].filePath).toBe("new.md");
    expect(store.getAllChunks()[0].id).toBe("new.md::0");
  });

  test("clear removes all data", () => {
    const store = new VectorStore("model-1");
    store.setFileChunks("a.md", [makeChunk("a.md", 0, [1, 2, 3])], makeMeta("a.md", 1));
    store.clear();

    expect(store.getChunkCount()).toBe(0);
    expect(store.getFileCount()).toBe(0);
  });

  test("serialize and deserialize round-trip", () => {
    const store = new VectorStore("model-1");
    const chunks = [makeChunk("a.md", 0, [1.5, 2.5, 3.5]), makeChunk("a.md", 1, [4.5, 5.5, 6.5])];
    store.setFileChunks("a.md", chunks, makeMeta("a.md", 2));

    const serialized = store.serialize();
    expect(serialized.version).toBe(1);
    expect(serialized.embeddingModelId).toBe("model-1");
    expect(serialized.chunks).toHaveLength(2);

    const store2 = new VectorStore("model-1");
    const ok = store2.deserialize(serialized);
    expect(ok).toBe(true);
    expect(store2.getChunkCount()).toBe(2);
    expect(store2.getFileCount()).toBe(1);

    // Vectors should survive base64 round-trip (Float32 precision).
    const v = store2.getAllChunks().find((c) => c.chunkIndex === 0)?.vector;
    expect(v).toBeDefined();
    expect(v![0]).toBeCloseTo(1.5, 5);
    expect(v![1]).toBeCloseTo(2.5, 5);
    expect(v![2]).toBeCloseTo(3.5, 5);
  });

  test("deserialize rejects mismatched model ID", () => {
    const store1 = new VectorStore("model-1");
    store1.setFileChunks("a.md", [makeChunk("a.md", 0, [1, 2, 3])], makeMeta("a.md", 1));
    const serialized = store1.serialize();

    const store2 = new VectorStore("model-2");
    const ok = store2.deserialize(serialized);
    expect(ok).toBe(false);
    expect(store2.getChunkCount()).toBe(0);
  });

  test("auto-detects dimensions from first chunk", () => {
    const store = new VectorStore("model-1");
    expect(store.getDimensions()).toBe(0);

    store.setFileChunks("a.md", [makeChunk("a.md", 0, [1, 2, 3, 4])], makeMeta("a.md", 1));
    expect(store.getDimensions()).toBe(4);
  });

  test("metadataEnriched flag round-trips through serialize/deserialize", () => {
    const store = new VectorStore("model-1", 0, 1000, 200, true);
    store.setFileChunks("a.md", [makeChunk("a.md", 0, [1, 2, 3])], makeMeta("a.md", 1));

    const serialized = store.serialize();
    expect(serialized.metadataEnriched).toBe(true);

    const store2 = new VectorStore("model-1");
    store2.deserialize(serialized);
    expect(store2.getMetadataEnriched()).toBe(true);
  });

  test("metadataEnriched defaults to false for legacy indexes", () => {
    const store = new VectorStore("model-1");
    store.setFileChunks("a.md", [makeChunk("a.md", 0, [1, 2, 3])], makeMeta("a.md", 1));

    const serialized = store.serialize();
    // Simulate a legacy index by removing the field.
    delete (serialized as Record<string, unknown>).metadataEnriched;

    const store2 = new VectorStore("model-1");
    store2.deserialize(serialized);
    expect(store2.getMetadataEnriched()).toBe(false);
  });
});

describe("base64 vector encoding", () => {
  test("round-trips a vector correctly", () => {
    const original = [1.0, -2.5, 3.14159, 0.0, 999.999];
    const encoded = vectorToBase64(original);
    const decoded = base64ToVector(encoded);

    expect(decoded).toHaveLength(original.length);
    for (let i = 0; i < original.length; i++) {
      // Float32 has limited precision, so check to ~5 decimal places.
      expect(decoded[i]).toBeCloseTo(original[i], 3);
    }
  });

  test("handles empty vector", () => {
    const encoded = vectorToBase64([]);
    const decoded = base64ToVector(encoded);
    expect(decoded).toEqual([]);
  });

  test("encoded string is shorter than JSON number array", () => {
    const vector = Array.from({ length: 384 }, (_, i) => Math.sin(i));
    const b64Length = vectorToBase64(vector).length;
    const jsonLength = JSON.stringify(vector).length;
    expect(b64Length).toBeLessThan(jsonLength);
  });
});

import { describe, test, expect } from "vitest";
import type { App } from "obsidian";
import { VaultIndexer } from "../../../src/rag/indexer";
import { VectorStore } from "../../../src/rag/vectorStore";
import type { EmbeddingClient } from "../../../src/rag/embeddingClient";
import type { IndexingState } from "../../../src/rag/types";

// One paragraph long enough to split into several chunks at chunkSize 80, so a
// "drop the last vector" response leaves a genuine hole in the middle of a file.
const LONG_CONTENT =
  "The rain fell steadily over the quiet harbour town that morning, and " +
  "Mara watched the grey water from her window while the fishing boats " +
  "rocked against the pier, their lanterns swaying in the wind as the " +
  "storm slowly gathered its strength far out beyond the breakwater wall.";

function makeApp(content: string): App {
  const file = { path: "note.md", stat: { mtime: 1 } };
  return {
    vault: {
      on: () => ({}),
      offref: () => {},
      getMarkdownFiles: () => [file],
      read: async () => content,
    },
    metadataCache: { getFileCache: () => null },
  } as unknown as App;
}

/** Returns one valid vector per input — a healthy embedding provider. */
const healthyClient: EmbeddingClient = {
  async embed(texts) {
    return { vectors: texts.map(() => [1, 2, 3]), dimensions: 3 };
  },
};

/** Drops the last vector — simulates a truncated/partial provider response. */
const truncatingClient: EmbeddingClient = {
  async embed(texts) {
    const vectors = texts.slice(0, Math.max(0, texts.length - 1)).map(() => [1, 2, 3]);
    return { vectors, dimensions: 3 };
  },
};

function makeIndexer(
  client: EmbeddingClient,
  app: App,
  store: VectorStore,
  states: IndexingState[],
): VaultIndexer {
  return new VaultIndexer({
    app,
    store,
    embeddingClient: client,
    embeddingModelId: "model-1",
    chunkSize: 80,
    chunkOverlap: 16,
    excludePatterns: [],
    metadataEnrichment: false,
    onStateChange: (s) => states.push(s),
    onSave: () => {},
  });
}

describe("VaultIndexer embedding validation", () => {
  test("rejects a file when the embed response is truncated (no hole persisted)", async () => {
    const states: IndexingState[] = [];
    const store = new VectorStore("model-1");
    const indexer = makeIndexer(truncatingClient, makeApp(LONG_CONTENT), store, states);

    await indexer.start();
    indexer.destroy();

    // The file must be rejected outright, never stored with an undefined vector.
    expect(store.getChunkCount()).toBe(0);

    const error = states.find((s) => s.status === "error");
    expect(error).toBeDefined();
    if (error?.status === "error") {
      // Honest about WHAT failed, not the laundered "could not reach the model".
      expect(error.message).toMatch(/vectors|input/i);
    }
  });

  test("indexes a file when every chunk gets a valid vector", async () => {
    const states: IndexingState[] = [];
    const store = new VectorStore("model-1");
    const indexer = makeIndexer(healthyClient, makeApp(LONG_CONTENT), store, states);

    await indexer.start();
    indexer.destroy();

    expect(store.getChunkCount()).toBeGreaterThan(0);
    expect(states.some((s) => s.status === "error")).toBe(false);
  });
});

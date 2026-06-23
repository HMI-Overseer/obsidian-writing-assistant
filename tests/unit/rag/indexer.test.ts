import { describe, test, expect, vi } from "vitest";
import { TFile } from "obsidian";
import type { App, TAbstractFile } from "obsidian";
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

// --------------------------------------------------------------------------
// Vault event wiring + content-hash dedup (P1-16)
// --------------------------------------------------------------------------

/** A TFile-like backed by content, for driving the live watchers. */
function mdFile(path: string, content: string, mtime = 1): TFile {
  const file = new TFile();
  file.path = path;
  (file as unknown as { stat: { mtime: number } }).stat = { mtime };
  (file as unknown as { content: string }).content = content;
  return file;
}

/** A counting embed client so dedup (skip-re-embed) is observable. */
function countingClient(): EmbeddingClient & { calls: () => number } {
  let calls = 0;
  return {
    async embed(texts) {
      calls++;
      return { vectors: texts.map(() => [1, 2, 3]), dimensions: 3 };
    },
    calls: () => calls,
  };
}

/** App whose vault captures the registered watcher handlers so tests can fire them. */
function makeEventApp(scanFiles: TFile[]) {
  const handlers: Record<string, (file: TAbstractFile, oldPath?: string) => void> = {};
  const offref = vi.fn();
  const app = {
    vault: {
      on: (event: string, handler: (file: TAbstractFile, oldPath?: string) => void) => {
        handlers[event] = handler;
        return { event };
      },
      offref,
      getMarkdownFiles: () => scanFiles,
      read: async (file: { content?: string }) => file.content ?? "",
    },
    metadataCache: { getFileCache: () => null },
  } as unknown as App;
  return { app, handlers, offref };
}

/** Let fire-and-forget watcher work (indexFile) settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function eventIndexer(
  client: EmbeddingClient,
  app: App,
  store: VectorStore,
  excludePatterns: string[] = [],
): VaultIndexer {
  return new VaultIndexer({
    app,
    store,
    embeddingClient: client,
    embeddingModelId: "model-1",
    chunkSize: 80,
    chunkOverlap: 16,
    excludePatterns,
    metadataEnrichment: false,
    onStateChange: () => {},
    onSave: () => {},
  });
}

describe("VaultIndexer vault event wiring", () => {
  test("registers create, modify, delete, and rename watchers on start", async () => {
    const { app, handlers } = makeEventApp([]);
    const indexer = eventIndexer(countingClient(), app, new VectorStore("model-1"));

    await indexer.start();
    indexer.destroy();

    expect(Object.keys(handlers).sort()).toEqual(["create", "delete", "modify", "rename"]);
  });

  test("destroy offrefs every registered watcher", async () => {
    const { app, offref } = makeEventApp([]);
    const indexer = eventIndexer(countingClient(), app, new VectorStore("model-1"));

    await indexer.start();
    indexer.destroy();

    expect(offref).toHaveBeenCalledTimes(4);
  });

  test("a create event indexes a new markdown file", async () => {
    const { app, handlers } = makeEventApp([]); // empty at scan time
    const client = countingClient();
    const store = new VectorStore("model-1");
    const indexer = eventIndexer(client, app, store);
    await indexer.start();
    expect(store.getChunkCount()).toBe(0);

    handlers.create(mdFile("new.md", LONG_CONTENT));
    await flush();
    indexer.destroy();

    expect(store.getChunkCount()).toBeGreaterThan(0);
    expect(client.calls()).toBeGreaterThan(0);
  });

  test("ignores create events for non-markdown files", async () => {
    const { app, handlers } = makeEventApp([]);
    const client = countingClient();
    const store = new VectorStore("model-1");
    const indexer = eventIndexer(client, app, store);
    await indexer.start();

    handlers.create(mdFile("notes/data.txt", LONG_CONTENT));
    await flush();
    indexer.destroy();

    expect(client.calls()).toBe(0);
    expect(store.getChunkCount()).toBe(0);
  });

  test("ignores create events for excluded markdown files", async () => {
    const { app, handlers } = makeEventApp([]);
    const client = countingClient();
    const store = new VectorStore("model-1");
    const indexer = eventIndexer(client, app, store, ["templates/**"]);
    await indexer.start();

    handlers.create(mdFile("templates/scene.md", LONG_CONTENT));
    await flush();
    indexer.destroy();

    expect(client.calls()).toBe(0);
    expect(store.getChunkCount()).toBe(0);
  });

  test("a delete event removes the file's chunks from the store", async () => {
    const file = mdFile("note.md", LONG_CONTENT);
    const { app, handlers } = makeEventApp([file]);
    const store = new VectorStore("model-1");
    const indexer = eventIndexer(countingClient(), app, store);
    await indexer.start();
    expect(store.getChunkCount()).toBeGreaterThan(0);

    handlers.delete(file);
    await flush();
    indexer.destroy();

    expect(store.getChunkCount()).toBe(0);
    expect(store.getFileMeta("note.md")).toBeUndefined();
  });

  test("a rename event re-keys the file's chunks to the new path", async () => {
    const file = mdFile("old.md", LONG_CONTENT);
    const { app, handlers } = makeEventApp([file]);
    const store = new VectorStore("model-1");
    const indexer = eventIndexer(countingClient(), app, store);
    await indexer.start();
    const chunkCount = store.getChunkCount();
    expect(chunkCount).toBeGreaterThan(0);

    const renamed = mdFile("new.md", LONG_CONTENT);
    handlers.rename(renamed, "old.md");
    await flush();
    indexer.destroy();

    expect(store.getFileMeta("old.md")).toBeUndefined();
    expect(store.getFileMeta("new.md")).toBeDefined();
    expect(store.getChunkCount()).toBe(chunkCount);
  });

  test("a modify with unchanged content skips re-embedding but refreshes mtime", async () => {
    const file = mdFile("note.md", LONG_CONTENT, 1);
    const { app, handlers } = makeEventApp([file]);
    const client = countingClient();
    const store = new VectorStore("model-1");
    const indexer = eventIndexer(client, app, store);
    await indexer.start();
    const embedsAfterScan = client.calls();
    expect(embedsAfterScan).toBeGreaterThan(0);

    // Same content, newer mtime (the classic "touched but not edited" case).
    (file as unknown as { stat: { mtime: number } }).stat.mtime = 2;
    handlers.modify(file);
    await flush();
    indexer.destroy();

    // Dedup: the unchanged content must not trigger another embed round...
    expect(client.calls()).toBe(embedsAfterScan);
    // ...but the mtime is refreshed so the next full scan won't re-check it.
    expect(store.getFileMeta("note.md")?.mtime).toBe(2);
  });
});

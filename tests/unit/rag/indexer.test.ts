import { describe, test, expect, vi } from "vitest";
import { TFile } from "obsidian";
import type { App, TAbstractFile } from "obsidian";
import { VaultIndexer, MODIFY_DEBOUNCE_MS } from "../../../src/rag/indexer";
import { VectorStore } from "../../../src/rag/vectorStore";
import type { EmbeddingClient } from "../../../src/rag/embeddingClient";
import type { IndexingState } from "../../../src/rag/types";

// One paragraph long enough to split into several chunks at chunkSize 80, so a
// "drop the last vector" response leaves a genuine hole in the middle of a file.
const LONG_CONTENT =
  "The rain fell steadily over the quiet harbour town that morning, and " +
  "Alice watched the grey water from her window while the fishing boats " +
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

/** Returns one valid vector per input, a healthy embedding provider. */
const healthyClient: EmbeddingClient = {
  async embed(texts) {
    return { vectors: texts.map(() => [1, 2, 3]), dimensions: 3 };
  },
};

/** Drops the last vector, simulates a truncated/partial provider response. */
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

/**
 * Drain the microtask queue several turns. Used under fake timers where
 * `flush()`'s real `setTimeout(0)` never fires, releasing a deferred embed
 * advances an `indexFile` chain (read → embed → store → dirty re-run) purely
 * through microtasks.
 */
const flushMicrotasks = async (turns = 8) => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};

/**
 * An embed client whose responses resolve only when the test releases them,
 * so a race between overlapping index runs can be driven deterministically.
 */
function deferredClient(): EmbeddingClient & { pending: Array<() => void>; calls: () => number } {
  const pending: Array<() => void> = [];
  let calls = 0;
  return {
    embed(texts) {
      calls++;
      return new Promise((resolve) => {
        pending.push(() => resolve({ vectors: texts.map(() => [1, 2, 3]), dimensions: 3 }));
      });
    },
    pending,
    calls: () => calls,
  };
}

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

  test("a create event indexes a new markdown file once the debounce elapses", async () => {
    vi.useFakeTimers();
    try {
      const { app, handlers } = makeEventApp([]); // empty at scan time
      const client = countingClient();
      const store = new VectorStore("model-1");
      const indexer = eventIndexer(client, app, store);
      await indexer.start();
      expect(store.getChunkCount()).toBe(0);

      handlers.create(mdFile("new.md", LONG_CONTENT));
      // Nothing is indexed until the per-file debounce window elapses.
      await vi.advanceTimersByTimeAsync(MODIFY_DEBOUNCE_MS - 1);
      expect(store.getChunkCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(2);
      indexer.destroy();

      expect(store.getChunkCount()).toBeGreaterThan(0);
      expect(client.calls()).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
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
    vi.useFakeTimers();
    try {
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
      await vi.advanceTimersByTimeAsync(MODIFY_DEBOUNCE_MS + 1);
      indexer.destroy();

      // Dedup: the unchanged content must not trigger another embed round...
      expect(client.calls()).toBe(embedsAfterScan);
      // ...but the mtime is refreshed so the next full scan won't re-check it.
      expect(store.getFileMeta("note.md")?.mtime).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// --------------------------------------------------------------------------
// Live modify-watcher debounce + in-flight guard (P1-11)
// --------------------------------------------------------------------------

describe("VaultIndexer modify-watcher debounce and in-flight guard", () => {
  test("coalesces a burst of rapid edits into a single index run", async () => {
    vi.useFakeTimers();
    try {
      const file = mdFile("note.md", LONG_CONTENT, 1);
      const { app, handlers } = makeEventApp([file]);
      const client = countingClient();
      const store = new VectorStore("model-1");
      const indexer = eventIndexer(client, app, store);
      await indexer.start();
      const afterScan = client.calls();
      expect(afterScan).toBeGreaterThan(0);

      // Three edits in quick succession, each landing before the debounce fires.
      [2, 3, 4].forEach((mtime, i) => {
        (file as unknown as { content: string }).content = `${LONG_CONTENT} edit ${i}`;
        (file as unknown as { stat: { mtime: number } }).stat.mtime = mtime;
        handlers.modify(file);
      });
      // The debounce keeps resetting, so no run has started yet.
      await vi.advanceTimersByTimeAsync(MODIFY_DEBOUNCE_MS - 1);
      expect(client.calls()).toBe(afterScan);

      // Once it finally elapses, the burst collapses to exactly one embed round.
      await vi.advanceTimersByTimeAsync(2);
      await flushMicrotasks();
      indexer.destroy();

      expect(client.calls()).toBe(afterScan + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("the latest content wins even when a stale run's embed resolves last", async () => {
    vi.useFakeTimers();
    try {
      const v1 = `${LONG_CONTENT} marker_stale_one`;
      const v2 = `${LONG_CONTENT} marker_fresh_two`;
      const file = mdFile("note.md", v1, 1);
      const { app, handlers } = makeEventApp([]); // nothing indexed at scan time
      const embed = deferredClient();
      const store = new VectorStore("model-1");
      const indexer = eventIndexer(embed, app, store);
      await indexer.start();

      // First edit: debounce fires, run A reads v1 and parks on its embed.
      handlers.modify(file);
      await vi.advanceTimersByTimeAsync(MODIFY_DEBOUNCE_MS + 1);
      expect(embed.pending.length).toBe(1); // run A is in flight

      // Second edit arrives mid-flight. It must be deferred, not run in parallel:
      // a parallel run would queue a second embed (pending.length === 2).
      (file as unknown as { content: string }).content = v2;
      (file as unknown as { stat: { mtime: number } }).stat.mtime = 2;
      handlers.modify(file);
      await vi.advanceTimersByTimeAsync(MODIFY_DEBOUNCE_MS + 1);
      expect(embed.pending.length).toBe(1); // still only A, B was marked dirty

      // Release embeds newest-first: the order that lets a stale run win when
      // unguarded. Guarded, A stores v1, then the dirty re-run reads and stores v2.
      while (embed.pending.length > 0) {
        const release = embed.pending.pop();
        release?.();
        await flushMicrotasks();
      }
      indexer.destroy();

      const text = store
        .getAllChunks()
        .map((c) => c.content)
        .join(" ");
      expect(text).toContain("marker_fresh_two");
      expect(text).not.toContain("marker_stale_one");
    } finally {
      vi.useRealTimers();
    }
  });
});

// --------------------------------------------------------------------------
// Automatic-reindex gate: never force-load the embedding model
// --------------------------------------------------------------------------

function gatedIndexer(
  client: EmbeddingClient,
  app: App,
  store: VectorStore,
  canAutoEmbed: () => Promise<boolean>,
  onStale: () => void = () => {},
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
    watchForChanges: true,
    canAutoEmbed,
    onStateChange: () => {},
    onSave: () => {},
    onStale,
  });
}

describe("VaultIndexer automatic-reindex gate", () => {
  test("a gated scan defers (no embed) when the model is not available", async () => {
    const file = mdFile("note.md", LONG_CONTENT);
    const { app } = makeEventApp([file]);
    const client = countingClient();
    const store = new VectorStore("model-1");
    let staleFired = 0;
    const indexer = gatedIndexer(client, app, store, async () => false, () => staleFired++);

    await indexer.runFullScan({ gated: true });

    // Nothing embedded or stored, and the file is recorded as stale for the chip.
    // (Assert before destroy(), which clears the deferred set.)
    expect(client.calls()).toBe(0);
    expect(store.getChunkCount()).toBe(0);
    expect(indexer.getDeferredCount()).toBe(1);
    expect(staleFired).toBeGreaterThan(0);
    indexer.destroy();
  });

  test("a gated scan indexes normally when the model is available", async () => {
    const file = mdFile("note.md", LONG_CONTENT);
    const { app } = makeEventApp([file]);
    const client = countingClient();
    const store = new VectorStore("model-1");
    const indexer = gatedIndexer(client, app, store, async () => true);

    await indexer.runFullScan({ gated: true });

    expect(client.calls()).toBeGreaterThan(0);
    expect(store.getChunkCount()).toBeGreaterThan(0);
    expect(indexer.getDeferredCount()).toBe(0);
    indexer.destroy();
  });

  test("a manual (ungated) scan indexes even when the gate would deny", async () => {
    const file = mdFile("note.md", LONG_CONTENT);
    const { app } = makeEventApp([file]);
    const client = countingClient();
    const store = new VectorStore("model-1");
    const indexer = gatedIndexer(client, app, store, async () => false);

    // A user-initiated build is allowed to run (and load the model) regardless.
    await indexer.runFullScan({ gated: false });

    expect(store.getChunkCount()).toBeGreaterThan(0);
    expect(indexer.getDeferredCount()).toBe(0);
    indexer.destroy();
  });

  test("a later gated scan drains the deferred set once the model comes back", async () => {
    const file = mdFile("note.md", LONG_CONTENT);
    const { app } = makeEventApp([file]);
    const client = countingClient();
    const store = new VectorStore("model-1");
    const gate = { ok: false };
    const indexer = gatedIndexer(client, app, store, async () => gate.ok);

    await indexer.runFullScan({ gated: true });
    expect(indexer.getDeferredCount()).toBe(1);
    expect(store.getChunkCount()).toBe(0);

    // Model becomes available: the next automatic scan catches the backlog up.
    gate.ok = true;
    await indexer.runFullScan({ gated: true });

    expect(indexer.getDeferredCount()).toBe(0);
    expect(store.getChunkCount()).toBeGreaterThan(0);
    indexer.destroy();
  });

  test("a live edit defers instead of loading the model, flagging staleness", async () => {
    vi.useFakeTimers();
    try {
      const { app, handlers } = makeEventApp([]); // empty at scan time
      const client = countingClient();
      const store = new VectorStore("model-1");
      let staleFired = 0;
      const indexer = gatedIndexer(client, app, store, async () => false, () => staleFired++);
      indexer.beginWatching();

      handlers.create(mdFile("note.md", LONG_CONTENT));
      await vi.advanceTimersByTimeAsync(MODIFY_DEBOUNCE_MS + 1);
      await flushMicrotasks();

      // The edit must not trigger an embed (which would JIT-load the model).
      expect(client.calls()).toBe(0);
      expect(store.getChunkCount()).toBe(0);
      expect(indexer.getDeferredCount()).toBe(1);
      expect(staleFired).toBeGreaterThan(0);
      indexer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

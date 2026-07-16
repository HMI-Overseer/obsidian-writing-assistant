import { TFile } from "obsidian";
import type { App, TAbstractFile } from "obsidian";
import { assertEmbeddingVectors } from "./embeddingClient";
import type { EmbeddingClient } from "./embeddingClient";
import type { IndexedChunk, FileIndexMeta, IndexingState, EmbeddingMetadata } from "./types";
import type { VectorStore } from "./vectorStore";
import { chunkDocument, fnv1aHash, buildEmbeddingText, preprocessMarkdown, extractWikilinks, extractFolder } from "./chunker";

/** Number of files to process per batch before yielding to the UI thread. */
const BATCH_SIZE = 5;

/** Maximum number of texts to send in a single embedding request. */
const EMBED_BATCH_SIZE = 32;

/** Delay in ms before persisting the index after the last batch. */
const SAVE_DEBOUNCE_MS = 2000;

/**
 * Delay in ms before (re-)indexing a file after its last create/modify event.
 * Coalesces a burst of rapid edits (and the create+modify pair Obsidian fires
 * for a new file) into a single index run instead of one run per keystroke.
 */
export const MODIFY_DEBOUNCE_MS = 500;

export interface IndexerOptions {
  app: App;
  store: VectorStore;
  embeddingClient: EmbeddingClient;
  embeddingModelId: string;
  chunkSize: number;
  chunkOverlap: number;
  excludePatterns: string[];
  metadataEnrichment: boolean;
  /** Register live vault watchers. Defaults to true (manual builds keep watching). */
  watchForChanges?: boolean;
  /**
   * Gate consulted before embedding on an *automatic* path (a live watcher edit
   * or a gated startup scan). Returns false when the model must not be
   * force-loaded (a local model that is not currently loaded, or a cloud model
   * the user has not opted into for auto-reindex). Absent means always allowed.
   * A manual build calls {@link VaultIndexer.runFullScan} with `gated: false`
   * and bypasses this entirely.
   */
  canAutoEmbed?: () => Promise<boolean>;
  onStateChange: (state: IndexingState) => void;
  // The debounced save may be async; the indexer fires it and does not await it (see
  // scheduleSave). The callee is expected to handle its own errors.
  onSave: () => void | Promise<void>;
  /** Notified whenever the deferred (changed-but-not-indexed) set changes. */
  onStale?: () => void;
}

/**
 * Vault indexer: watches for file changes and maintains the vector store.
 *
 * Call `start()` to perform the initial index and register vault watchers.
 * Call `destroy()` to unregister watchers and cancel pending work.
 */
export class VaultIndexer {
  private readonly app: App;
  private readonly store: VectorStore;
  private readonly client: EmbeddingClient;
  private readonly modelId: string;
  private readonly chunkSize: number;
  private readonly chunkOverlap: number;
  private readonly excludePatterns: string[];
  private readonly metadataEnrichment: boolean;
  private readonly watchForChanges: boolean;
  private readonly canAutoEmbed?: () => Promise<boolean>;
  private readonly onStateChange: (state: IndexingState) => void;
  private readonly onSave: () => void | Promise<void>;
  private readonly onStale: () => void;

  private saveTimer: number | null = null;
  private abortController: AbortController | null = null;
  private eventRefs: Array<ReturnType<App["vault"]["on"]>> = [];
  private destroyed = false;
  private watching = false;

  /** Per-file debounce timers for watcher-triggered (re-)indexing. */
  private readonly indexTimers = new Map<string, number>();
  /** Paths with an index run currently in flight (read → embed → store). */
  private readonly indexing = new Set<string>();
  /** Paths that changed again mid-flight and must be re-indexed once that run ends. */
  private readonly dirty = new Set<string>();
  /**
   * Paths known to have changed but left un-indexed because an automatic run was
   * not allowed to embed (model not loaded, or cloud without opt-in). This set
   * is the cheap "index out of date" signal the chip reads; the authoritative
   * list of what actually needs work is always recomputed by mtime in a scan.
   */
  private readonly deferred = new Set<string>();

  constructor(options: IndexerOptions) {
    this.app = options.app;
    this.store = options.store;
    this.client = options.embeddingClient;
    this.modelId = options.embeddingModelId;
    this.chunkSize = options.chunkSize;
    this.chunkOverlap = options.chunkOverlap;
    this.excludePatterns = options.excludePatterns;
    this.metadataEnrichment = options.metadataEnrichment;
    this.watchForChanges = options.watchForChanges ?? true;
    this.canAutoEmbed = options.canAutoEmbed;
    this.onStateChange = options.onStateChange;
    this.onSave = options.onSave;
    this.onStale = options.onStale ?? (() => {});
  }

  /**
   * Convenience: begin watching (if enabled) and run a forced full scan. Kept
   * for callers that want the old one-shot behavior; {@link RagService} drives
   * {@link beginWatching} and {@link runFullScan} separately so it can gate the
   * scan without loading the model.
   */
  async start(): Promise<void> {
    this.beginWatching();
    await this.runFullScan({ gated: false });
  }

  /** Register live vault watchers once, if this indexer is configured to watch. */
  beginWatching(): void {
    if (this.watching || this.destroyed || !this.watchForChanges) return;
    this.watching = true;
    this.registerVaultEvents();
  }

  /** Number of files known to be stale (changed but not yet indexed). */
  getDeferredCount(): number {
    return this.deferred.size;
  }

  /** Unregister vault events and cancel pending work. */
  destroy(): void {
    this.destroyed = true;
    this.abortController?.abort();

    for (const ref of this.eventRefs) {
      this.app.vault.offref(ref);
    }
    this.eventRefs = [];

    for (const timer of this.indexTimers.values()) {
      window.clearTimeout(timer);
    }
    this.indexTimers.clear();
    this.dirty.clear();
    this.deferred.clear();

    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  private registerVaultEvents(): void {
    this.eventRefs.push(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile && this.isMarkdownFile(file)) {
          this.scheduleIndex(file);
        }
      }),
    );

    this.eventRefs.push(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && this.isMarkdownFile(file)) {
          this.scheduleIndex(file);
        }
      }),
    );

    this.eventRefs.push(
      this.app.vault.on("delete", (file) => {
        if (this.isMarkdownFile(file)) {
          this.clearPendingIndex(file.path);
          this.store.removeFile(file.path);
          this.scheduleSave();
        }
      }),
    );

    this.eventRefs.push(
      this.app.vault.on("rename", (file, oldPath) => {
        if (this.isMarkdownFile(file)) {
          this.clearPendingIndex(oldPath);
          this.store.renameFile(oldPath, file.path);
          this.scheduleSave();
        }
      }),
    );
  }

  private isMarkdownFile(file: TAbstractFile): boolean {
    return file.path.endsWith(".md") && !this.isExcluded(file.path);
  }

  private isExcluded(filePath: string): boolean {
    return this.excludePatterns.some((pattern) => matchGlob(pattern, filePath));
  }

  /**
   * Scan all markdown files and index stale/new ones. `gated` scans (startup
   * catch-up, deferred drain) consult {@link canAutoEmbed} first and stop before
   * any embed call when the model is not ready, recording the stale files rather
   * than force-loading. A manual build passes `gated: false` and always runs.
   */
  async runFullScan(opts: { gated: boolean }): Promise<void> {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const files = this.app.vault.getMarkdownFiles().filter((f) => !this.isExcluded(f.path));

    // Remove files from the store that no longer exist in the vault.
    const vaultPaths = new Set(files.map((f) => f.path));
    for (const meta of this.store.getAllFileMeta()) {
      if (!vaultPaths.has(meta.filePath)) {
        this.store.removeFile(meta.filePath);
      }
    }

    // Find files that need (re-)indexing.
    const staleFiles: TFile[] = [];
    for (const file of files) {
      const meta = this.store.getFileMeta(file.path);
      if (!meta || meta.mtime !== file.stat.mtime) {
        staleFiles.push(file);
      }
    }

    if (staleFiles.length === 0) {
      this.clearDeferred();
      this.onStateChange({ status: "idle" });
      return;
    }

    // Automatic scans must never load the embedding model. If it is not ready,
    // remember what is stale (so the chip can flag it) and stop before embedding.
    if (!(await this.allowedToEmbed(opts.gated))) {
      for (const file of staleFiles) this.deferred.add(file.path);
      this.onStateChange({ status: "idle" });
      this.onStale();
      return;
    }

    this.onStateChange({
      status: "indexing",
      filesProcessed: 0,
      filesTotal: staleFiles.length,
    });

    try {
      for (let i = 0; i < staleFiles.length; i += BATCH_SIZE) {
        if (signal.aborted || this.destroyed) return;

        const batch = staleFiles.slice(i, i + BATCH_SIZE);
        await this.indexBatch(batch, signal);

        this.onStateChange({
          status: "indexing",
          filesProcessed: Math.min(i + BATCH_SIZE, staleFiles.length),
          filesTotal: staleFiles.length,
        });

        // Yield to the UI thread between batches.
        if (i + BATCH_SIZE < staleFiles.length) {
          await yieldToMain();
        }
      }

      this.scheduleSave();
      this.clearDeferred();
      this.onStateChange({ status: "idle" });
    } catch (error) {
      if (!signal.aborted && !this.destroyed) {
        const message = error instanceof Error ? error.message : String(error);
        this.onStateChange({ status: "error", message });
      }
    }
  }

  /** Whether an embed may run now: ungated always, gated only if the model is ready. */
  private async allowedToEmbed(gated: boolean): Promise<boolean> {
    if (!gated || !this.canAutoEmbed) return true;
    return this.canAutoEmbed();
  }

  /** Forget the stale set (all pending files were just indexed), notifying if it changed. */
  private clearDeferred(): void {
    if (this.deferred.size === 0) return;
    this.deferred.clear();
    this.onStale();
  }

  /** Record a path as stale (deferred), notifying only when the set actually grows. */
  private markDeferred(path: string): void {
    const before = this.deferred.size;
    this.deferred.add(path);
    if (this.deferred.size !== before) this.onStale();
  }

  /**
   * Debounce a watcher-triggered (re-)index of a single file. Collapses a burst
   * of rapid events for the same path into one run after the edits settle.
   */
  private scheduleIndex(file: TFile): void {
    if (this.destroyed) return;
    const path = file.path;
    const existing = this.indexTimers.get(path);
    if (existing) window.clearTimeout(existing);
    this.indexTimers.set(
      path,
      window.setTimeout(() => {
        this.indexTimers.delete(path);
        void this.indexFileGuarded(file);
      }, MODIFY_DEBOUNCE_MS),
    );
  }

  /** Cancel any pending debounce and clear dirty state for a path (e.g. on delete/rename). */
  private clearPendingIndex(path: string): void {
    const timer = this.indexTimers.get(path);
    if (timer) {
      window.clearTimeout(timer);
      this.indexTimers.delete(path);
    }
    this.dirty.delete(path);
    if (this.deferred.delete(path)) this.onStale();
  }

  /**
   * Index a file under a per-file in-flight guard. If a run is already in
   * progress for this path, mark it dirty and re-run once with the latest
   * content when that run finishes, rather than starting an overlapping run
   * whose stale embed could resolve last, win the store, and stamp the latest
   * mtime, poisoning the vector until a model change forces a re-index.
   */
  private async indexFileGuarded(file: TFile): Promise<void> {
    if (this.destroyed) return;
    const path = file.path;
    if (this.indexing.has(path)) {
      this.dirty.add(path);
      return;
    }

    // Live watching is an automatic path: if the embedding model is not ready,
    // defer this file rather than force-load it. The chip reflects the staleness.
    if (!(await this.allowedToEmbed(true))) {
      this.markDeferred(path);
      return;
    }

    this.indexing.add(path);
    let redispatched = false;
    try {
      await this.indexFile(file);
    } finally {
      this.indexing.delete(path);
      if (this.dirty.has(path) && !this.destroyed) {
        this.dirty.delete(path);
        redispatched = true;
        void this.indexFileGuarded(file);
      }
    }

    if (redispatched || this.destroyed) return;

    // The model just answered, so it is loaded now: catch up anything deferred
    // while it was down with one gated scan (which re-defers if it went away).
    if (this.deferred.size > 0) {
      this.deferred.clear();
      this.onStale();
      void this.runFullScan({ gated: true });
    }
  }

  /** Index a single file (used by the watcher debounce/guard). */
  private async indexFile(file: TFile): Promise<void> {
    try {
      await this.indexBatch([file]);
      this.scheduleSave();
    } catch {
      // Single file failures during live watching are non-fatal.
    }
  }

  /** Index a batch of files: read, chunk, embed, store. */
  private async indexBatch(files: TFile[], signal?: AbortSignal): Promise<void> {
    for (const file of files) {
      if (signal?.aborted || this.destroyed) return;

      const content = await this.app.vault.read(file);
      const contentHash = fnv1aHash(content);

      // Skip if content hasn't actually changed (mtime update without content change).
      const existingMeta = this.store.getFileMeta(file.path);
      if (existingMeta && existingMeta.contentHash === contentHash) {
        // Update mtime so we don't re-check next time.
        this.store.setFileChunks(
          file.path,
          this.store.getAllChunks().filter((c) => c.filePath === file.path),
          { ...existingMeta, mtime: file.stat.mtime },
        );
        continue;
      }

      // Extract metadata from raw content before preprocessing strips it.
      let embeddingMeta: EmbeddingMetadata | undefined;
      if (this.metadataEnrichment) {
        const links = extractWikilinks(content);
        const folder = extractFolder(file.path);
        const cache = this.app.metadataCache.getFileCache(file);
        const tags: string[] = [];
        if (cache?.frontmatter?.tags) {
          // Frontmatter values are untyped (any) user YAML; treat as unknown and narrow.
          const raw: unknown = cache.frontmatter.tags;
          if (Array.isArray(raw)) {
            tags.push(...raw.map(String));
          } else if (typeof raw === "string") {
            tags.push(raw);
          }
        }
        embeddingMeta = { tags, folder, links };
      }

      const cleaned = preprocessMarkdown(content);
      const chunks = chunkDocument(file.path, cleaned, this.chunkSize, this.chunkOverlap);

      if (chunks.length === 0) {
        this.store.removeFile(file.path);
        continue;
      }

      // Embed chunks in batches.
      const indexedChunks: IndexedChunk[] = [];
      for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
        if (signal?.aborted || this.destroyed) return;

        const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
        const texts = batch.map((c) => buildEmbeddingText(c, embeddingMeta));
        const result = await this.client.embed(texts, this.modelId, signal);
        // Reject a truncated/short response before it reaches the store: throwing
        // here aborts this file before setFileChunks, so it is never persisted
        // with an undefined vector that would poison retrieval.
        assertEmbeddingVectors(batch.length, result.vectors);

        for (let j = 0; j < batch.length; j++) {
          indexedChunks.push({
            ...batch[j],
            vector: result.vectors[j],
          });
        }
      }

      const meta: FileIndexMeta = {
        filePath: file.path,
        mtime: file.stat.mtime,
        contentHash,
        chunkCount: indexedChunks.length,
      };

      this.store.setFileChunks(file.path, indexedChunks, meta);
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      // Fire-and-forget: a debounced background persist that handles its own errors.
      void this.onSave();
    }, SAVE_DEBOUNCE_MS);
  }
}

/** Yield to the main thread to keep the UI responsive. */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

/** Simple glob matching supporting `*` and `**` patterns. */
function matchGlob(pattern: string, path: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  return new RegExp(`^${regex}$`).test(path);
}

import { TFile } from "obsidian";
import type { App, TAbstractFile } from "obsidian";
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

export interface IndexerOptions {
  app: App;
  store: VectorStore;
  embeddingClient: EmbeddingClient;
  embeddingModelId: string;
  chunkSize: number;
  chunkOverlap: number;
  excludePatterns: string[];
  metadataEnrichment: boolean;
  onStateChange: (state: IndexingState) => void;
  onSave: () => void;
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
  private readonly onStateChange: (state: IndexingState) => void;
  private readonly onSave: () => void;

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;
  private eventRefs: Array<ReturnType<App["vault"]["on"]>> = [];
  private destroyed = false;

  constructor(options: IndexerOptions) {
    this.app = options.app;
    this.store = options.store;
    this.client = options.embeddingClient;
    this.modelId = options.embeddingModelId;
    this.chunkSize = options.chunkSize;
    this.chunkOverlap = options.chunkOverlap;
    this.excludePatterns = options.excludePatterns;
    this.metadataEnrichment = options.metadataEnrichment;
    this.onStateChange = options.onStateChange;
    this.onSave = options.onSave;
  }

  /** Perform the initial index scan and register vault watchers. */
  async start(): Promise<void> {
    this.registerVaultEvents();
    await this.runFullScan();
  }

  /** Unregister vault events and cancel pending work. */
  destroy(): void {
    this.destroyed = true;
    this.abortController?.abort();

    for (const ref of this.eventRefs) {
      this.app.vault.offref(ref);
    }
    this.eventRefs = [];

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  private registerVaultEvents(): void {
    this.eventRefs.push(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile && this.isMarkdownFile(file)) {
          this.indexFile(file);
        }
      }),
    );

    this.eventRefs.push(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && this.isMarkdownFile(file)) {
          this.indexFile(file);
        }
      }),
    );

    this.eventRefs.push(
      this.app.vault.on("delete", (file) => {
        if (this.isMarkdownFile(file)) {
          this.store.removeFile(file.path);
          this.scheduleSave();
        }
      }),
    );

    this.eventRefs.push(
      this.app.vault.on("rename", (file, oldPath) => {
        if (this.isMarkdownFile(file)) {
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

  /** Scan all markdown files and index stale/new ones. */
  private async runFullScan(): Promise<void> {
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
      this.onStateChange({ status: "idle" });
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
      this.onStateChange({ status: "idle" });
    } catch (error) {
      if (!signal.aborted && !this.destroyed) {
        const message = error instanceof Error ? error.message : String(error);
        this.onStateChange({ status: "error", message });
      }
    }
  }

  /** Index a single file (used by vault watchers). */
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
          const raw = cache.frontmatter.tags;
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
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.onSave();
    }, SAVE_DEBOUNCE_MS);
  }
}

/** Yield to the main thread to keep the UI responsive. */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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

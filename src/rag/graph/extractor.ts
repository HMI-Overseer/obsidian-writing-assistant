import type { App, TFile } from "obsidian";
import type { ChatClient } from "../../api/chatClient";
import type { ChatRequest } from "../../shared/chatRequest";
import type { SamplingParams } from "../../shared/types";
import type { GraphBuildState, GraphFileMeta, ExtractionResult } from "./types";
import type { KnowledgeGraph } from "./knowledgeGraph";
import type { EmbeddingClient } from "../embeddingClient";
import { chunkDocument, fnv1aHash, preprocessMarkdown } from "../chunker";

/** Number of files to process per batch before yielding to the UI thread. */
const BATCH_SIZE = 3;

/** Target chunk size for extraction (larger than embedding chunks — LLMs handle more context). */
const EXTRACTION_CHUNK_SIZE = 3000;
const EXTRACTION_CHUNK_OVERLAP = 200;

/** Delay in ms before persisting the graph after the last batch. */
const SAVE_DEBOUNCE_MS = 2000;

const EXTRACTION_SYSTEM_PROMPT = `You are an entity and relationship extractor. Given a passage from a creative writing vault, extract:
1. Entities: characters, locations, objects, concepts, events
2. Relationships between entities

Return ONLY valid JSON in this exact format:
{
  "entities": [
    { "name": "Alice", "type": "character", "description": "A wandering knight" }
  ],
  "relationships": [
    { "source": "Alice", "target": "Iron Castle", "type": "resides in", "description": "Alice has lived in the Iron Castle since childhood" }
  ]
}

Rules:
- Entity types must be one of: character, location, object, concept, event
- Use the most specific canonical name for entities (e.g. "Alice" not "she")
- Relationship types should be short verb phrases (e.g. "allies with", "located in", "caused")
- Only extract entities and relationships that are clearly stated or strongly implied
- If no entities or relationships are found, return {"entities": [], "relationships": []}
- Return ONLY the JSON object, no additional text`;

/** Sampling parameters for extraction: low temperature for consistent structured output. */
const EXTRACTION_PARAMS: SamplingParams = {
  temperature: 0.1,
  maxTokens: 2000,
  topP: null,
  topK: null,
  minP: null,
  repeatPenalty: null,
  reasoning: null,
};

export interface GraphExtractorOptions {
  app: App;
  graph: KnowledgeGraph;
  chatClient: ChatClient;
  modelId: string;
  excludePatterns: string[];
  onStateChange: (state: GraphBuildState) => void;
  onSave: () => void;
  /** Optional embedding client for generating entity vectors at build time. */
  embeddingClient?: EmbeddingClient;
  /** The modelId to pass to the embedding client. */
  embeddingModelId?: string;
}

/**
 * Vault scanner that extracts entities and relationships from markdown files
 * using an LLM, building a KnowledgeGraph.
 *
 * Mirrors the VaultIndexer pattern: call `start()` to scan, `destroy()` to cancel.
 */
export class GraphExtractor {
  private readonly app: App;
  private readonly graph: KnowledgeGraph;
  private readonly client: ChatClient;
  private readonly modelId: string;
  private readonly excludePatterns: string[];
  private readonly onStateChange: (state: GraphBuildState) => void;
  private readonly onSave: () => void;
  private readonly embeddingClient: EmbeddingClient | undefined;
  private readonly embeddingModelId: string | undefined;

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;
  private destroyed = false;

  constructor(options: GraphExtractorOptions) {
    this.app = options.app;
    this.graph = options.graph;
    this.client = options.chatClient;
    this.modelId = options.modelId;
    this.excludePatterns = options.excludePatterns;
    this.onStateChange = options.onStateChange;
    this.onSave = options.onSave;
    this.embeddingClient = options.embeddingClient;
    this.embeddingModelId = options.embeddingModelId;
  }

  /** Scan vault and extract entities/relations from all markdown files. */
  async start(): Promise<void> {
    await this.runFullScan();
  }

  /** Cancel in-progress extraction and clean up. */
  destroy(): void {
    this.destroyed = true;
    this.abortController?.abort();

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  private async runFullScan(): Promise<void> {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const files = this.app.vault
      .getMarkdownFiles()
      .filter((f) => !this.isExcluded(f.path));

    // Find files that need (re-)extraction.
    const staleFiles: TFile[] = [];
    for (const file of files) {
      const meta = this.graph.getFileMeta(file.path);
      if (!meta || meta.mtime !== file.stat.mtime) {
        staleFiles.push(file);
      }
    }

    // Remove files from the graph that no longer exist in the vault.
    const vaultPaths = new Set(files.map((f) => f.path));
    for (const meta of this.graph.getAllFileMeta()) {
      if (!vaultPaths.has(meta.filePath)) {
        this.graph.removeFile(meta.filePath);
      }
    }

    if (staleFiles.length === 0) {
      this.onStateChange({ status: "idle" });
      return;
    }

    this.onStateChange({
      status: "extracting",
      filesProcessed: 0,
      filesTotal: staleFiles.length,
    });

    try {
      for (let i = 0; i < staleFiles.length; i += BATCH_SIZE) {
        if (signal.aborted || this.destroyed) return;

        const batch = staleFiles.slice(i, i + BATCH_SIZE);
        await this.extractBatch(batch, signal);

        this.onStateChange({
          status: "extracting",
          filesProcessed: Math.min(i + BATCH_SIZE, staleFiles.length),
          filesTotal: staleFiles.length,
        });

        // Yield to the UI thread between batches.
        if (i + BATCH_SIZE < staleFiles.length) {
          await yieldToMain();
        }
      }

      this.graph.markBuilt();
      this.scheduleSave();
      this.onStateChange({ status: "idle" });
    } catch (error) {
      if (!signal.aborted && !this.destroyed) {
        const message = error instanceof Error ? error.message : String(error);
        this.onStateChange({ status: "error", message });
      }
    }
  }

  /** Extract entities/relations from a batch of files. */
  private async extractBatch(files: TFile[], signal?: AbortSignal): Promise<void> {
    for (const file of files) {
      if (signal?.aborted || this.destroyed) return;

      const content = await this.app.vault.read(file);
      const contentHash = fnv1aHash(content);

      // Skip if content hasn't actually changed.
      const existingMeta = this.graph.getFileMeta(file.path);
      if (existingMeta && existingMeta.contentHash === contentHash) {
        return;
      }

      const cleaned = preprocessMarkdown(content);
      const chunks = chunkDocument(
        file.path,
        cleaned,
        EXTRACTION_CHUNK_SIZE,
        EXTRACTION_CHUNK_OVERLAP,
      );

      if (chunks.length === 0) {
        this.graph.removeFile(file.path);
        continue;
      }

      // Extract from each chunk and merge results.
      const mergedResult: ExtractionResult = { entities: [], relationships: [] };

      for (const chunk of chunks) {
        if (signal?.aborted || this.destroyed) return;

        const extraction = await this.extractFromText(chunk.content, signal);
        if (extraction) {
          mergedResult.entities.push(...extraction.entities);
          mergedResult.relationships.push(...extraction.relationships);
        }
      }

      const meta: GraphFileMeta = {
        filePath: file.path,
        mtime: file.stat.mtime,
        contentHash,
      };

      this.graph.addExtractions(file.path, mergedResult, meta);

      if (this.embeddingClient && this.embeddingModelId) {
        await this.embedNewEntities(file.path);
      }

      this.scheduleSave();
    }
  }

  /** Embed any entities from this file that don't yet have a vector. */
  private async embedNewEntities(filePath: string): Promise<void> {
    if (!this.embeddingClient || !this.embeddingModelId) return;

    const entities = this.graph.getEntitiesInFile(filePath).filter((e) => !e.embedding);
    if (entities.length === 0) return;

    try {
      const texts = entities.map((e) => `${e.name}: ${e.description}`);
      const result = await this.embeddingClient.embed(texts, this.embeddingModelId);

      for (let i = 0; i < entities.length; i++) {
        if (result.vectors[i]) entities[i].embedding = result.vectors[i];
      }
    } catch {
      // Non-fatal — entity will be embedded on next build.
    }
  }

  /** Call the LLM to extract entities and relationships from a text chunk. */
  private async extractFromText(
    text: string,
    signal?: AbortSignal,
  ): Promise<ExtractionResult | null> {
    const request: ChatRequest = {
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      documentContext: null,
      ragContext: null,
      messages: [{ role: "user", content: text }],
    };

    try {
      const result = await this.client.complete(
        request,
        this.modelId,
        EXTRACTION_PARAMS,
        signal,
      );
      return parseExtractionResponse(result.text);
    } catch {
      // Individual chunk failures are non-fatal — skip and continue.
      return null;
    }
  }

  private isExcluded(filePath: string): boolean {
    return this.excludePatterns.some((pattern) => matchGlob(pattern, filePath));
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.onSave();
    }, SAVE_DEBOUNCE_MS);
  }
}

/**
 * Parse the LLM's extraction response into structured data.
 * Handles common issues: markdown code fences, trailing text, malformed JSON.
 */
export function parseExtractionResponse(text: string): ExtractionResult | null {
  // Strip markdown code fences if present.
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  // Find the JSON object boundaries.
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  try {
    const parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));

    const entities = Array.isArray(parsed.entities)
      ? parsed.entities.filter(
          (e: unknown): e is ExtractionResult["entities"][number] =>
            typeof e === "object" &&
            e !== null &&
            typeof (e as Record<string, unknown>).name === "string" &&
            typeof (e as Record<string, unknown>).type === "string" &&
            typeof (e as Record<string, unknown>).description === "string",
        )
      : [];

    const relationships = Array.isArray(parsed.relationships)
      ? parsed.relationships.filter(
          (r: unknown): r is ExtractionResult["relationships"][number] =>
            typeof r === "object" &&
            r !== null &&
            typeof (r as Record<string, unknown>).source === "string" &&
            typeof (r as Record<string, unknown>).target === "string" &&
            typeof (r as Record<string, unknown>).type === "string" &&
            typeof (r as Record<string, unknown>).description === "string",
        )
      : [];

    return { entities, relationships };
  } catch {
    return null;
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

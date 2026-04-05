import type {
  GraphEntity,
  GraphRelation,
  GraphFileMeta,
  SerializedKnowledgeGraph,
  EntityType,
  ExtractionResult,
} from "./types";

/** Normalize entity names for deduplication: lowercase and trim. */
function normalizeEntityName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * In-memory knowledge graph built from LLM-extracted entities and relations.
 *
 * Supports deduplication (entities merge by normalized name), traversal
 * (BFS neighborhood), and file-level queries. Serializable for disk persistence.
 */
export class KnowledgeGraph {
  /** Normalized name → entity. */
  private entities = new Map<string, GraphEntity>();
  /** All relations. */
  private relations: GraphRelation[] = [];
  /** filePath → set of normalized entity names found in that file. */
  private fileEntityIndex = new Map<string, Set<string>>();
  /** Tracks which files have been extracted. */
  private fileMeta: GraphFileMeta[] = [];

  private modelId = "";
  private builtAt = 0;

  // ── Query methods ──────────────────────────────────────────────────

  /** Find entities whose name or aliases contain the search term (case-insensitive). */
  findEntities(query: string): GraphEntity[] {
    const normalized = normalizeEntityName(query);
    if (!normalized) return [];

    const results: GraphEntity[] = [];
    for (const entity of this.entities.values()) {
      const entityNorm = normalizeEntityName(entity.name);
      // Forward: query mentions the entity (require min 4 chars to avoid matching
      // common short words like "it", "he", "at" that appear in any sentence).
      // Reverse: short query is a substring of the entity name (e.g. "iron" finds "Iron Castle").
      const nameMatch =
        (entityNorm.length >= 4 && normalized.includes(entityNorm)) ||
        entityNorm.includes(normalized);
      const aliasMatch = entity.aliases.some((a) => {
        const aliasNorm = normalizeEntityName(a);
        return (aliasNorm.length >= 4 && normalized.includes(aliasNorm)) || aliasNorm.includes(normalized);
      });
      if (nameMatch || aliasMatch) {
        results.push(entity);
      }
    }
    return results;
  }

  /** Get all relations involving a given entity (by canonical name). */
  getRelations(entityName: string): GraphRelation[] {
    const normalized = normalizeEntityName(entityName);
    return this.relations.filter(
      (r) =>
        normalizeEntityName(r.source) === normalized ||
        normalizeEntityName(r.target) === normalized,
    );
  }

  /**
   * BFS traversal: find entities within `maxHops` of a starting entity.
   * Returns a map of normalized entity name → hop distance.
   */
  getNeighborhood(entityName: string, maxHops: number): Map<string, number> {
    const startKey = normalizeEntityName(entityName);
    if (!this.entities.has(startKey)) return new Map();

    const distances = new Map<string, number>();
    distances.set(startKey, 0);
    const queue: string[] = [startKey];

    while (queue.length > 0) {
      const current = queue.shift() as string;
      const currentDist = distances.get(current) ?? 0;
      if (currentDist >= maxHops) continue;

      for (const rel of this.relations) {
        const sourceKey = normalizeEntityName(rel.source);
        const targetKey = normalizeEntityName(rel.target);

        let neighbor: string | null = null;
        if (sourceKey === current && !distances.has(targetKey)) {
          neighbor = targetKey;
        } else if (targetKey === current && !distances.has(sourceKey)) {
          neighbor = sourceKey;
        }

        if (neighbor) {
          distances.set(neighbor, currentDist + 1);
          queue.push(neighbor);
        }
      }
    }

    return distances;
  }

  /** Get all entity names found in a given file. */
  getEntitiesInFile(filePath: string): GraphEntity[] {
    const names = this.fileEntityIndex.get(filePath);
    if (!names) return [];

    const results: GraphEntity[] = [];
    for (const name of names) {
      const entity = this.entities.get(name);
      if (entity) results.push(entity);
    }
    return results;
  }

  /**
   * Get all source files for entities within `maxHops` of the given entity.
   * Returns a map of filePath → relevance (inverse hop distance).
   */
  getRelevantFiles(entityName: string, maxHops: number): Map<string, number> {
    const neighborhood = this.getNeighborhood(entityName, maxHops);
    const fileRelevance = new Map<string, number>();

    for (const [normalizedName, distance] of neighborhood) {
      const entity = this.entities.get(normalizedName);
      if (!entity) continue;

      const relevance = 1 / (1 + distance);
      for (const file of entity.sourceFiles) {
        const existing = fileRelevance.get(file) ?? 0;
        fileRelevance.set(file, Math.max(existing, relevance));
      }
    }

    return fileRelevance;
  }

  getEntityCount(): number {
    return this.entities.size;
  }

  getRelationCount(): number {
    return this.relations.length;
  }

  getFileCount(): number {
    return this.fileMeta.length;
  }

  getBuiltAt(): number {
    return this.builtAt;
  }

  getAllFileMeta(): GraphFileMeta[] {
    return [...this.fileMeta];
  }

  getFileMeta(filePath: string): GraphFileMeta | undefined {
    return this.fileMeta.find((m) => m.filePath === filePath);
  }

  // ── Mutation methods ───────────────────────────────────────────────

  /**
   * Add extraction results from a single file.
   * Merges entities by normalized name; increments relation weights for duplicates.
   */
  addExtractions(
    filePath: string,
    extraction: ExtractionResult,
    meta: GraphFileMeta,
  ): void {
    // Remove any previous data for this file before adding new extractions.
    this.removeFile(filePath);

    const fileEntityNames = new Set<string>();

    for (const raw of extraction.entities) {
      const key = normalizeEntityName(raw.name);
      if (!key) continue;

      const existing = this.entities.get(key);
      if (existing) {
        // Merge: add source file, update description if longer.
        if (!existing.sourceFiles.includes(filePath)) {
          existing.sourceFiles.push(filePath);
        }
        if (raw.description.length > existing.description.length) {
          existing.description = raw.description;
        }
      } else {
        this.entities.set(key, {
          name: raw.name,
          type: raw.type as EntityType,
          description: raw.description,
          sourceFiles: [filePath],
          aliases: [],
        });
      }
      fileEntityNames.add(key);
    }

    for (const raw of extraction.relationships) {
      const sourceKey = normalizeEntityName(raw.source);
      const targetKey = normalizeEntityName(raw.target);
      if (!sourceKey || !targetKey) continue;

      // Check for duplicate relation.
      const existing = this.relations.find(
        (r) =>
          normalizeEntityName(r.source) === sourceKey &&
          normalizeEntityName(r.target) === targetKey &&
          r.type === raw.type,
      );

      if (existing) {
        existing.weight += 1;
      } else {
        this.relations.push({
          source: raw.source,
          target: raw.target,
          type: raw.type,
          description: raw.description,
          sourceFile: filePath,
          weight: 1,
        });
      }
    }

    this.fileEntityIndex.set(filePath, fileEntityNames);

    // Update file metadata.
    const metaIdx = this.fileMeta.findIndex((m) => m.filePath === filePath);
    if (metaIdx >= 0) {
      this.fileMeta[metaIdx] = meta;
    } else {
      this.fileMeta.push(meta);
    }
  }

  /** Remove all data associated with a file. */
  removeFile(filePath: string): void {
    // Remove entities that only exist in this file.
    const entityNames = this.fileEntityIndex.get(filePath);
    if (entityNames) {
      for (const name of entityNames) {
        const entity = this.entities.get(name);
        if (entity) {
          entity.sourceFiles = entity.sourceFiles.filter((f) => f !== filePath);
          if (entity.sourceFiles.length === 0) {
            this.entities.delete(name);
          }
        }
      }
      this.fileEntityIndex.delete(filePath);
    }

    // Remove relations sourced from this file.
    this.relations = this.relations.filter((r) => r.sourceFile !== filePath);

    // Remove file metadata.
    this.fileMeta = this.fileMeta.filter((m) => m.filePath !== filePath);
  }

  /** Clear all graph data. */
  clear(): void {
    this.entities.clear();
    this.relations = [];
    this.fileEntityIndex.clear();
    this.fileMeta = [];
    this.builtAt = 0;
  }

  // ── Serialization ──────────────────────────────────────────────────

  serialize(modelId: string): SerializedKnowledgeGraph {
    return {
      version: 1,
      modelId,
      builtAt: this.builtAt || Date.now(),
      files: [...this.fileMeta],
      entities: [...this.entities.values()],
      relations: [...this.relations],
    };
  }

  /**
   * Load from serialized data. Returns false on version or model mismatch.
   */
  deserialize(data: SerializedKnowledgeGraph, expectedModelId: string): boolean {
    if (data.version !== 1 || data.modelId !== expectedModelId) {
      return false;
    }

    this.clear();
    this.modelId = data.modelId;
    this.builtAt = data.builtAt;
    this.fileMeta = [...data.files];

    // Rebuild entity map and file index.
    for (const entity of data.entities) {
      const key = normalizeEntityName(entity.name);
      this.entities.set(key, { ...entity, aliases: entity.aliases ?? [] });

      for (const file of entity.sourceFiles) {
        const existing = this.fileEntityIndex.get(file) ?? new Set();
        existing.add(key);
        this.fileEntityIndex.set(file, existing);
      }
    }

    this.relations = [...data.relations];
    return true;
  }

  /** Update the builtAt timestamp to now. */
  markBuilt(): void {
    this.builtAt = Date.now();
  }
}

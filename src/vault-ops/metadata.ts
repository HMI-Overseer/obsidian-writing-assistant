import type { App, MetadataCache, TFile } from "obsidian";
import { normalizePath } from "obsidian";

/**
 * Obsidian exposes these MetadataCache methods at runtime but omits them from its
 * published TypeScript definitions. Declaring the augmentation once keeps the cast
 * (and the shape it asserts) in a single place instead of drifting across the
 * read-tool and proposal-building call sites.
 */
export interface ExtendedMetadataCache extends MetadataCache {
  /**
   * The runtime returns a dictionary whose `data` is a `Map` from source path to
   * the link references in that note (read from the 1.13.7 bundle). It was never a
   * plain object, and `Object.keys` on a Map is always empty, which is how incoming
   * links read as none for every note.
   */
  getBacklinksForFile(file: TFile): { data: Map<string, unknown[]> } | null | undefined;
  getTags(): Record<string, number>;
}

/**
 * Number of notes that link to a file, the `linkImpact` shown for move ops. Returns
 * 0 for an unknown path or a file with no incoming links.
 */
export function backlinkCount(app: App, path: string): number {
  const file = app.vault.getFileByPath(normalizePath(path));
  if (!file) return 0;
  return backlinkSources(app, file).length;
}

/**
 * The paths of the notes that link to `file`, unsorted. The one reader of
 * `getBacklinksForFile`, so its shape is asserted in a single place: the `data`
 * Map's keys, or the keys of a plain object should an older build return one.
 */
export function backlinkSources(app: App, file: TFile): string[] {
  const backlinks = (app.metadataCache as ExtendedMetadataCache).getBacklinksForFile(file);
  const data: unknown = backlinks?.data;
  if (data instanceof Map) return Array.from(data.keys() as Iterable<string>);
  if (data && typeof data === "object") return Object.keys(data);
  return [];
}

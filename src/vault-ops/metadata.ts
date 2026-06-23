import type { App, MetadataCache, TFile } from "obsidian";
import { normalizePath } from "obsidian";

/**
 * Obsidian exposes these MetadataCache methods at runtime but omits them from its
 * published TypeScript definitions. Declaring the augmentation once keeps the cast
 * (and the shape it asserts) in a single place instead of drifting across the
 * read-tool and proposal-building call sites.
 */
export interface ExtendedMetadataCache extends MetadataCache {
  getBacklinksForFile(file: TFile): { data: Record<string, unknown[]> };
  getTags(): Record<string, number>;
}

/**
 * Number of notes that link to a file, the `linkImpact` shown for move ops. Returns
 * 0 for an unknown path or a file with no incoming links.
 */
export function backlinkCount(app: App, path: string): number {
  const file = app.vault.getFileByPath(normalizePath(path));
  if (!file) return 0;
  const backlinks = (app.metadataCache as ExtendedMetadataCache).getBacklinksForFile(file);
  return Object.keys(backlinks?.data ?? {}).length;
}

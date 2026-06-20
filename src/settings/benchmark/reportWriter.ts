import { normalizePath } from "obsidian";
import type { App, TFile } from "obsidian";

/**
 * Creates a benchmark report note in the vault and returns the created file.
 *
 * The folder (including missing parents) is created if needed, and an existing
 * note with the same name is never overwritten, the file name gets a numeric
 * suffix instead.
 */
export async function writeBenchmarkReport(
  app: App,
  folder: string,
  baseName: string,
  content: string,
): Promise<TFile> {
  const folderPath = normalizePath(folder.trim() || "Benchmarks");

  if (!app.vault.getFolderByPath(folderPath)) {
    await createFolderWithParents(app, folderPath);
  }

  let path = normalizePath(`${folderPath}/${baseName}.md`);
  for (let suffix = 1; app.vault.getAbstractFileByPath(path) !== null; suffix++) {
    path = normalizePath(`${folderPath}/${baseName} (${suffix}).md`);
  }

  return app.vault.create(path, content);
}

async function createFolderWithParents(app: App, folderPath: string): Promise<void> {
  const segments = folderPath.split("/");
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    if (!app.vault.getFolderByPath(current)) {
      await app.vault.createFolder(current);
    }
  }
}

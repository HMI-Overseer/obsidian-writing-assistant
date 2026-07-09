import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * CI guard for docs/01-product/features.md: it is the canonical feature -> source
 * map, so every `src/...` path it cites must exist on disk. Catches the kind of
 * drift where a file is renamed or deleted (e.g. DiffReviewPanel.ts ->
 * DiffHunkView.ts) but the registry keeps pointing at the old path.
 *
 * Scoped to features.md deliberately: historical records (ADRs, RESOLVED- issues,
 * implementation plans) cite files as they existed at the time and must stay as
 * point-in-time records, so they are not validated here.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const featuresPath = resolve(repoRoot, "docs/01-product/features.md");

// Backticked source citations like `src/chat/messages/DiffHunkView.ts`.
const SRC_CITATION = /`(src\/[\w./-]+\.(?:ts|tsx|css))`/g;

describe("features.md source citations", () => {
  // Skip rather than fail if the docs submodule isn't checked out, a missing
  // submodule is an environment gap, not a broken citation.
  it.skipIf(!existsSync(featuresPath))("every cited src/ path exists on disk", () => {
    const text = readFileSync(featuresPath, "utf8");
    const cited = [...text.matchAll(SRC_CITATION)].map((m) => m[1]);

    // Sanity: if the regex stops matching (format changed), the guard is vacuous.
    expect(cited.length).toBeGreaterThan(0);

    const missing = [...new Set(cited)].filter((p) => !existsSync(resolve(repoRoot, p)));
    expect(missing, `Broken src citations in features.md: ${missing.join(", ")}`).toEqual([]);
  });
});

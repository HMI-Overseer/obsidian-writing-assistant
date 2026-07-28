// Resolves and caches Obsidian's own `app.css` for the visual harness project.
//
// The harness loads Obsidian's real stylesheet so the plugin-vs-Obsidian cascade (unlayered rules,
// native input/button chrome, theme variables) is reproduced, which a plain browser cannot do. That CSS
// is Obsidian's proprietary asset: it is extracted from the locally installed app into a gitignored
// cache and MUST NOT be committed or redistributed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR, extractObsidianFile } from "./obsidianInstall.mjs";

const CACHE = join(CACHE_DIR, "app.css");

// Returns Obsidian's app.css as a string, extracting + caching on first use.
export function getAppCss({ refresh = false } = {}) {
  if (!refresh && existsSync(CACHE)) return readFileSync(CACHE, "utf8");
  const css = extractObsidianFile("app.css");
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE, css);
  return css;
}

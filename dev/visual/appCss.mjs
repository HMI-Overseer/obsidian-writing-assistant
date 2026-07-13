// Resolves and caches Obsidian's own `app.css` for the visual harness.
//
// The harness loads Obsidian's real stylesheet so the plugin-vs-Obsidian cascade (unlayered rules,
// native input/button chrome, theme variables) is reproduced, which a plain browser cannot do. That CSS
// is Obsidian's proprietary asset: it is extracted from the locally installed app into a gitignored
// cache and MUST NOT be committed or redistributed.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as asar from "@electron/asar";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, ".cache", "app.css");

// Candidate directories that hold an Obsidian `*.asar`. Override with OBSIDIAN_ASAR=<full path>.
function candidateAsars() {
  const out = [];
  if (process.env.OBSIDIAN_ASAR) out.push(process.env.OBSIDIAN_ASAR);
  const dirs = [
    process.env.APPDATA && join(process.env.APPDATA, "obsidian"), // Windows (auto-updated copy)
    process.env.HOME && join(process.env.HOME, ".config", "obsidian"), // Linux
    process.env.HOME && join(process.env.HOME, "Library", "Application Support", "obsidian"), // macOS
  ].filter(Boolean);
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const asars = readdirSync(dir)
      .filter((f) => /obsidian.*\.asar$/i.test(f) || f === "app.asar")
      .map((f) => join(dir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs); // newest first
    out.push(...asars);
  }
  return out;
}

// Returns Obsidian's app.css as a string, extracting + caching on first use.
export function getAppCss({ refresh = false } = {}) {
  if (!refresh && existsSync(CACHE)) return readFileSync(CACHE, "utf8");
  for (const archive of candidateAsars()) {
    try {
      const css = asar.extractFile(archive, "app.css").toString("utf8");
      mkdirSync(dirname(CACHE), { recursive: true });
      writeFileSync(CACHE, css);
      return css;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(
    "Could not locate Obsidian's app.css. Set OBSIDIAN_ASAR=<path to obsidian-*.asar> and retry.\n" +
      "On Windows it is typically %APPDATA%/obsidian/obsidian-<version>.asar.",
  );
}

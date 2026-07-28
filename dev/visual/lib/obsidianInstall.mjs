// Locates the locally installed Obsidian: reads single files out of its asar archive, and reports
// which Chromium its Electron is built on.
//
// Everything the harness borrows from Obsidian (the stylesheet, the icon geometry) is Obsidian's
// proprietary asset: it is read from the local install into a gitignored cache and MUST NOT be
// committed or redistributed. Consumers own their own cache file; this module only finds the
// install and pulls what it is asked for out of it.
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as asar from "@electron/asar";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Directory holding the gitignored copies of whatever we extract. */
export const CACHE_DIR = resolve(HERE, "..", ".cache");

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

/**
 * Reads one entry (`app.css`, `app.js`, …) out of the newest Obsidian asar we can find.
 * Throws with the override hint if no install yields the entry.
 */
export function extractObsidianFile(entry) {
  for (const archive of candidateAsars()) {
    try {
      return asar.extractFile(archive, entry).toString("utf8");
    } catch {
      // try the next candidate
    }
  }
  throw new Error(
    `Could not read ${entry} from an Obsidian install. Set OBSIDIAN_ASAR=<path to obsidian-*.asar> and retry.\n` +
      "On Windows it is typically %APPDATA%/obsidian/obsidian-<version>.asar.",
  );
}

// Obsidian's Electron binary, which carries the Chromium version string. Override with
// OBSIDIAN_EXE=<full path>.
function candidateExecutables() {
  const out = [];
  if (process.env.OBSIDIAN_EXE) out.push(process.env.OBSIDIAN_EXE);
  if (process.env.LOCALAPPDATA) {
    out.push(join(process.env.LOCALAPPDATA, "Programs", "Obsidian", "Obsidian.exe"));
  }
  out.push("/Applications/Obsidian.app/Contents/MacOS/Obsidian");
  if (process.env.HOME) {
    out.push(join(process.env.HOME, "Applications", "Obsidian.app", "Contents", "MacOS", "Obsidian"));
  }
  out.push("/opt/Obsidian/obsidian", "/usr/bin/obsidian", "/usr/local/bin/obsidian");
  return out.filter((p) => existsSync(p));
}

const UA_VERSION = /Chrome\/(\d+\.\d+\.\d+\.\d+)/;
const SCAN_CHUNK = 4 * 1024 * 1024;

// The binary runs to hundreds of megabytes, so scan it in chunks (overlapping enough that a match
// cannot straddle a boundary) and remember the answer.
function scanForChromiumVersion(file) {
  const fd = openSync(file, "r");
  try {
    const overlap = 64;
    const buf = Buffer.alloc(SCAN_CHUNK + overlap);
    let position = 0;
    let carried = 0;
    for (;;) {
      const bytes = readSync(fd, buf, carried, SCAN_CHUNK, position);
      if (bytes <= 0) return null;
      const match = UA_VERSION.exec(buf.toString("latin1", 0, carried + bytes));
      if (match) return match[1];
      buf.copy(buf, 0, carried + bytes - overlap, carried + bytes);
      carried = overlap;
      position += bytes;
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * The Chromium version Obsidian renders with, or null if no install could be read. Advisory only:
 * the harness reports it so a divergence from the browser doing the rendering stays visible instead
 * of silently passing CSS the app cannot support.
 */
export function getObsidianChromiumVersion() {
  const cache = join(CACHE_DIR, "chromium-version.txt");
  if (existsSync(cache)) return readFileSync(cache, "utf8").trim() || null;
  for (const exe of candidateExecutables()) {
    const version = scanForChromiumVersion(exe);
    if (version) {
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(cache, version);
      return version;
    }
  }
  return null;
}

/**
 * Vault-path normalization for tool-call arguments.
 *
 * The write/read tools document *vault-relative* paths, but a local model
 * sometimes supplies the wrong shape. Two are handled here, both rewritten back
 * to a true vault-relative path at the tool-call boundary so the normal
 * validators see the real target:
 *
 *  1. An absolute filesystem path (e.g. "D:\vault\ExampleVault\sandbox 2\Lore").
 *     Left untranslated it resolves to nothing in the vault, silently bypassing
 *     the folder/existence guards, and surfaces later as a baffling apply-time
 *     error ("…\Lore no longer exists").
 *  2. A relative path that redundantly leads with the *vault's own name*
 *     (e.g. "ExampleVault/sandbox 2" in a vault named "ExampleVault"). Vault ops
 *     apply relative to the root, so this lands at "ExampleVault/ExampleVault/…", a
 *     spurious nested folder. The leading vault-name segment is always redundant.
 */

import { type App, FileSystemAdapter, TFolder, normalizePath } from "obsidian";
import type { ToolCall } from "./types";

/** Tool-argument keys carrying a single vault path (write/edit + most reads). */
const PATH_ARG_KEYS = ["path", "from", "to"] as const;

/** Tool-argument keys carrying an *array* of vault paths (e.g. get_frontmatter `paths`). */
const PATH_ARRAY_ARG_KEYS = ["paths"] as const;

/**
 * Per-tool path-arg keys whose value must reference an *existing* file, so a
 * confusable-punctuation mismatch may be snapped to the real on-disk path
 * ({@link snapToExistingFile}). Deliberately excludes write destinations
 * (`write_file.path`, `move_file.to`, `create_directory.path`, `replace_in_vault.path`):
 * those are meant to be absent, and snapping one could silently retarget a new file
 * onto an existing note. Read/source/edit-target keys only.
 *
 * Exported for the drift guard in `tests/unit/tools/paths.test.ts`: the keys are tool
 * names nothing typechecks, so a rename that misses one silently switches snapping off
 * for that tool. The guard asserts every key is still an advertised tool.
 */
export const SNAP_TOOL_KEYS: Record<string, readonly string[]> = {
  read_file: ["path"],
  get_outline: ["path"],
  read_section: ["path"],
  get_backlinks: ["path"],
  get_outgoing_links: ["path"],
  trash_file: ["path"],
  propose_edit: ["path"],
  insert_into_note: ["path"],
  update_frontmatter: ["path"],
  get_frontmatter: ["paths"],
  move_file: ["from"],
};

/**
 * Fold the punctuation a model routinely "straightens" when it emits a path, so two
 * spellings of the same filename compare equal: curly ↔ straight quotes, en/em dashes
 * ↔ hyphen, ellipsis ↔ three dots, plus Unicode NFC. These are genuinely distinct
 * codepoints that `normalizePath` does not reconcile (e.g. ’ U+2019 vs ' U+0027), so
 * an exact `getFileByPath` lookup misses even though the file is right there.
 */
function foldConfusables(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...");
}

/**
 * When an exact lookup of `path` fails, try to resolve it to a real file in the same
 * parent folder whose name matches once confusable punctuation is folded
 * ({@link foldConfusables}). Returns the file's *real* on-disk path on a unique match,
 * or the input unchanged when the path already resolves, nothing matches, or more than
 * one candidate folds the same (ambiguous, never guess). Only ever snaps to a real
 * in-vault file, so the vault-boundary guard is never weakened. Leaf-only: a confusable
 * in a parent *folder* segment is left for the normal not-found path (rare; the common
 * case is an apostrophe in the filename).
 */
export function snapToExistingFile(app: App, path: string): string {
  const normalized = normalizePath(path);
  if (app.vault.getAbstractFileByPath(normalized)) return path; // exact hit, nothing to fix

  const slash = normalized.lastIndexOf("/");
  const parentPath = slash > 0 ? normalized.slice(0, slash) : "";
  const parent = parentPath
    ? app.vault.getAbstractFileByPath(parentPath)
    : app.vault.getRoot();
  if (!(parent instanceof TFolder)) return path;

  const target = foldConfusables(normalized);
  let match: string | null = null;
  for (const child of parent.children) {
    if (foldConfusables(child.path) !== target) continue;
    if (match !== null) return path; // ambiguous (>1 fold to the same), don't guess
    match = child.path;
  }
  return match ?? path;
}

/**
 * Absolute vault root (`FileSystemAdapter.getBasePath`), or undefined on a
 * non-filesystem vault (e.g. mobile, which this desktop-only plugin never runs on).
 */
export function vaultBasePath(app: App): string | undefined {
  const adapter = app.vault.adapter;
  return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : undefined;
}

/**
 * Drop a leading path segment equal to the vault name. The vault is the root, so
 * a path beginning with its own name is usually a redundant prefix the model
 * added. The caller ({@link normalizeVaultToolCall}) passes `vaultName` only when
 * no real top-level folder by that name exists, so when it *is* passed, stripping
 * is unambiguous (a genuine same-named folder is left addressable by withholding
 * the name here). Only the `<name>/rest` *prefix* form is stripped; a bare
 * `<name>` is left alone. Case-insensitive; tolerates leading slashes.
 */
function stripVaultNamePrefix(path: string, vaultName: string | undefined): string {
  if (!vaultName) return path;
  const rel = path.replace(/^\/+/, "");
  const prefix = `${vaultName}/`;
  if (rel.length > prefix.length && rel.toLowerCase().startsWith(prefix.toLowerCase())) {
    return rel.slice(prefix.length);
  }
  return rel;
}

/**
 * Translate a model-supplied path into a vault-relative one (see the module
 * doc-comment for the two shapes handled). An absolute path *outside* the vault
 * is returned unchanged so the normal validators judge it, and the vault-boundary
 * guard ({@link ../vault-ops/pathSafety.escapesVault}) then refuses it with a
 * self-correcting error rather than letting it land outside the vault.
 *
 * Comparison is case-insensitive: Windows drive letters and the default macOS
 * filesystem don't distinguish case, so we match loosely but slice from the
 * original string to preserve the path's real casing.
 */
export function toVaultRelativePath(
  rawPath: string,
  basePath: string | undefined,
  vaultName?: string,
): string {
  const slashed = rawPath.replace(/\\/g, "/").replace(/\/+$/, "");

  // 1) Absolute path inside the vault → strip the base path, then any redundant
  //    vault-name segment left in the remainder.
  if (basePath) {
    const root = basePath.replace(/\\/g, "/").replace(/\/+$/, "");
    if (root !== "") {
      const lowerSlashed = slashed.toLowerCase();
      const lowerRoot = root.toLowerCase();
      if (lowerSlashed === lowerRoot) return "";
      if (lowerSlashed.startsWith(`${lowerRoot}/`)) {
        return stripVaultNamePrefix(slashed.slice(root.length + 1), vaultName);
      }
    }
  }

  // 2) Relative path (or absolute path outside the vault) → only strip a
  //    redundant leading vault-name segment; otherwise leave it for the validators.
  const stripped = stripVaultNamePrefix(slashed, vaultName);
  return stripped === slashed ? rawPath : stripped;
}

/**
 * Rewrite every vault-path argument of a tool call to its vault-relative form
 * (see {@link toVaultRelativePath}). Returns the call unchanged when nothing
 * needs translating, so identity is preserved for the common (already-relative)
 * case and callers can cheaply skip re-wrapping.
 */
export function normalizeVaultToolCall(app: App, call: ToolCall): ToolCall {
  const base = vaultBasePath(app);
  // Treat a leading vault-name segment as redundant only when no real top-level
  // item by that name exists; otherwise the model may legitimately mean that
  // folder, so leave the path for the validators. This keeps a folder named
  // exactly like the vault fully addressable.
  const vaultName = app.vault.getName();
  const name =
    vaultName && !app.vault.getAbstractFileByPath(normalizePath(vaultName)) ? vaultName : undefined;
  const snapKeys = SNAP_TOOL_KEYS[call.name] ?? [];

  // Rewrite a single path: first to its vault-relative shape, then (for keys that
  // must reference an existing file) snap a confusable-punctuation mismatch to the
  // real on-disk path. Snapping runs last so it sees the already-relative path.
  const rewrite = (value: string, key: string): string => {
    const relative = toVaultRelativePath(value, base, name);
    return snapKeys.includes(key) ? snapToExistingFile(app, relative) : relative;
  };

  let changed = false;
  const args: Record<string, unknown> = { ...call.arguments };
  for (const key of PATH_ARG_KEYS) {
    const value = args[key];
    if (typeof value !== "string") continue;
    const rewritten = rewrite(value, key);
    if (rewritten !== value) {
      args[key] = rewritten;
      changed = true;
    }
  }
  for (const key of PATH_ARRAY_ARG_KEYS) {
    const value = args[key];
    if (!Array.isArray(value)) continue;
    let arrayChanged = false;
    const rewritten = value.map((entry: unknown) => {
      if (typeof entry !== "string") return entry;
      const next = rewrite(entry, key);
      if (next !== entry) arrayChanged = true;
      return next;
    });
    if (arrayChanged) {
      args[key] = rewritten;
      changed = true;
    }
  }
  return changed ? { ...call, arguments: args } : call;
}

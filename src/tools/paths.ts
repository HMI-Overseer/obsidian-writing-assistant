/**
 * Vault-path normalization for tool-call arguments.
 *
 * The write/read tools document *vault-relative* paths, but a local model
 * sometimes supplies the wrong shape. Two are handled here, both rewritten back
 * to a true vault-relative path at the tool-call boundary so the normal
 * validators see the real target:
 *
 *  1. An absolute filesystem path (e.g. "D:\vault\Harbingers\sandbox 2\Lore").
 *     Left untranslated it resolves to nothing in the vault — silently bypassing
 *     the folder/existence guards — and surfaces later as a baffling apply-time
 *     error ("…\Lore no longer exists").
 *  2. A relative path that redundantly leads with the *vault's own name*
 *     (e.g. "Harbingers/sandbox 2" in a vault named "Harbingers"). Vault ops
 *     apply relative to the root, so this lands at "Harbingers/Harbingers/…" — a
 *     spurious nested folder. The leading vault-name segment is always redundant.
 */

import { type App, FileSystemAdapter, normalizePath } from "obsidian";
import type { ToolCall } from "./types";

/** Tool-argument keys carrying a single vault path (write/edit + most reads). */
const PATH_ARG_KEYS = ["path", "from", "to"] as const;

/** Tool-argument keys carrying an *array* of vault paths (e.g. get_frontmatter `paths`). */
const PATH_ARRAY_ARG_KEYS = ["paths"] as const;

/**
 * Absolute vault root (`FileSystemAdapter.getBasePath`), or undefined on a
 * non-filesystem vault (e.g. mobile — which this desktop-only plugin never runs on).
 */
export function vaultBasePath(app: App): string | undefined {
  const adapter = app.vault.adapter;
  return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : undefined;
}

/**
 * Drop a leading path segment equal to the vault name. The vault is the root, so
 * a path beginning with its own name is usually a redundant prefix the model
 * added. The caller ({@link normalizeVaultToolCall}) passes `vaultName` only when
 * no real top-level folder by that name exists — so when it *is* passed, stripping
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
 * is returned unchanged so the normal validators judge it (it then fails
 * honestly as not-found rather than landing somewhere unexpected).
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
  if (!base && !name) return call;

  let changed = false;
  const args: Record<string, unknown> = { ...call.arguments };
  for (const key of PATH_ARG_KEYS) {
    const value = args[key];
    if (typeof value !== "string") continue;
    const relative = toVaultRelativePath(value, base, name);
    if (relative !== value) {
      args[key] = relative;
      changed = true;
    }
  }
  for (const key of PATH_ARRAY_ARG_KEYS) {
    const value = args[key];
    if (!Array.isArray(value)) continue;
    let arrayChanged = false;
    const rewritten = value.map((entry) => {
      if (typeof entry !== "string") return entry;
      const relative = toVaultRelativePath(entry, base, name);
      if (relative !== entry) arrayChanged = true;
      return relative;
    });
    if (arrayChanged) {
      args[key] = rewritten;
      changed = true;
    }
  }
  return changed ? { ...call, arguments: args } : call;
}

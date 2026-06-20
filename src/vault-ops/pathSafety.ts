/**
 * Vault-boundary safety for operation paths.
 *
 * The write tools document *vault-relative* paths, and every op must stay inside
 * the vault. A path that escapes, `..` traversal that rises above the root, or a
 * Windows drive-letter absolute (`C:/…`), would land outside the vault once
 * `path.join(vaultRoot, p)` resolves it (Obsidian's `normalizePath` does not collapse
 * `..`). So it is refused at three independent layers: the in-loop validator (the
 * model gets a self-correcting error before any review), the apply pre-flight (the
 * batch is refused), and the apply executor itself (the only code that touches disk).
 *
 * A leading slash is *not* treated as an escape: `normalizePath` strips it, so the
 * path resolves inside the vault. Internal `..` that stays within the vault
 * (e.g. `a/../b.md`) is allowed, only traversal that rises above the root is refused.
 *
 * Pure (no Obsidian, no disk) so the guard is unit-testable and identical across
 * every layer it defends.
 */

/**
 * True when a vault-relative path would resolve outside the vault root:
 *  - a Windows drive-letter prefix (`C:`, `d:\`), never a valid vault path; or
 *  - `..` segments that traverse above the root.
 */
export function escapesVault(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  // A drive letter (C:, d:\) is an absolute filesystem path, never vault-relative.
  if (/^[a-zA-Z]:/.test(normalized)) return true;
  // Walk segments tracking depth below the root; rising above it (depth < 0) escapes.
  let depth = 0;
  for (const segment of normalized.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      depth -= 1;
      if (depth < 0) return true;
    } else {
      depth += 1;
    }
  }
  return false;
}

/** Model-facing reason a path was refused, in the self-correcting validator style. */
export function outsideVaultMessage(path: string): string {
  return `"${path}" is outside the vault. Use a vault-relative path.`;
}

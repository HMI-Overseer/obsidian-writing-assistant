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
 * A leading slash alone is *not* treated as an escape: `normalizePath` strips it, so
 * the path resolves inside the vault, but a leading slash that merely shields a
 * drive-letter absolute (`/C:/…`) is still refused, since `normalizePath` strips the
 * slash to a bare `C:/…`. Internal `..` that stays within the vault (e.g. `a/../b.md`)
 * is allowed, only traversal that rises above the root is refused.
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
  // Strip leading slashes first: `/C:/…` shields the drive letter from this test, yet
  // normalizePath later strips the slash to a bare `C:/…`, so both forms must be refused.
  if (/^[a-zA-Z]:/.test(normalized.replace(/^\/+/, ""))) return true;
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

/**
 * True when a path's first segment, after collapsing any `.`/`..`, is the vault's
 * configuration directory (`app.vault.configDir`, conventionally `.obsidian`). Model
 * write / overwrite / move-into / create-directory ops are refused here as defense in
 * depth: the file-type allowlist already blocks `.json`/`.css` config files, but a `.md`
 * or `.canvas` written into the config subtree would otherwise pass it, and a stray write
 * there can corrupt the vault's configuration. This guard stands in front of the
 * (default "ask") gate so the model never even proposes a config-subtree write.
 *
 * The `..` collapse matters because `normalizePath` does *not* fold `..`, so a path like
 * `foo/../.obsidian/x.md` reaches the guard first-segment-innocuous yet `path.join`
 * collapses it into the config dir on disk. Only the first *resolved* segment is compared,
 * exact-match, so a folder whose name merely starts with the config dir name
 * (`.obsidian-archive`) is not over-rejected.
 *
 * `configDir` is the *live* value (sourced from `app.vault.configDir` at the
 * call site), so a user who renamed their config directory is still protected,
 * and a vault that legitimately holds a folder named `.obsidian` is not.
 */
export function isReservedConfigPath(path: string, configDir: string): boolean {
  const target = (configDir ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!target) return false;
  const resolved: string[] = [];
  for (const segment of path.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      resolved.pop();
    } else {
      resolved.push(segment);
    }
  }
  return resolved[0] === target;
}

/** Model-facing reason a config-subtree path was refused. */
export function reservedConfigMessage(path: string, configDir: string): string {
  return (
    `"${path}" is inside the ${configDir} configuration folder, which is off limits. ` +
    `Write to the vault's note area instead.`
  );
}

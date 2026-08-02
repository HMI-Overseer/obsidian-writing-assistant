/**
 * Writable file-type allowlist for model-created vault files.
 *
 * The invariant: **no file with a non-blessed extension ever lands in the vault
 * from a model action.** Only the extensions Obsidian treats as first-class text
 * documents are allowed, a Markdown note (`.md`) or an Obsidian canvas
 * (`.canvas`). Everything else is refused with a self-correcting error: a
 * no-extension path (almost always a forgotten `.md`), a non-document type
 * (`.json` plugin data, `.css` snippets, …), and, the reason this is an
 * **allowlist, not a denylist**, any executable/script type (`.bat`, `.exe`,
 * `.cmd`, `.ps1`, `.sh`, `.js`, `.html`, …). An allowlist is *closed by default*,
 * so a dangerous type we never thought to block cannot slip through. The plugin
 * has no execute surface, but a model could still land e.g. `run.bat` in the vault
 * that a user later double-clicks, so we refuse to create it at all.
 *
 * Enforced at every door a model can introduce a new file extension through:
 *  - {@link ../validation.validateWriteFile}, `write_file`'s path (create + overwrite); and
 *  - {@link ../validation.validateMove}, `move`'s **destination on its note pathway**, so
 *    a move can't launder a blessed file (`note.md`) into a forbidden type (`note.bat`).
 *    `move` also moves folders, which have no extension, so the check runs only when the
 *    source probes as a file. That branch is chosen from the source's on-disk state, not
 *    from an argument, so the model cannot route a note down the folder pathway to escape
 *    the allowlist.
 *
 * Scope: this constrains what the model may **newly write or rename to**. It
 * deliberately does not gate the disk executor, which must still recreate any
 * pre-existing file (e.g. undo of a trashed attachment) regardless of type.
 *
 * Note: only `.md` is fully addressable by the markdown-indexed tools
 * (`search_content` / `edit` / `update_frontmatter`); `.canvas` is a real
 * Obsidian document but those tools won't see it. Extend
 * {@link WRITABLE_FILE_EXTENSIONS} to widen the allowlist.
 *
 * Pure (no Obsidian, no disk) so the guard is unit-testable and identical wherever
 * it is enforced.
 */

/** Extensions `write_file` may create or overwrite (lower-case, leading dot). */
export const WRITABLE_FILE_EXTENSIONS = [".md", ".canvas"] as const;

/** True when the path's final segment ends in an allowlisted extension. */
export function hasWritableExtension(path: string): boolean {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  // dot <= 0 ⇒ no extension at all, or a dotfile with no stem (".md"), neither is
  // a document the tool should create.
  if (dot <= 0) return false;
  const ext = name.slice(dot).toLowerCase();
  return (WRITABLE_FILE_EXTENSIONS as readonly string[]).includes(ext);
}

/** Model-facing reason a path's type was refused, in the self-correcting style. */
export function unsupportedTypeMessage(path: string): string {
  return (
    `"${path}" has an unsupported file type, only Obsidian documents can be written to the vault. ` +
    `Use a path ending in ${WRITABLE_FILE_EXTENSIONS.join(" or ")} (for a note, use .md).`
  );
}

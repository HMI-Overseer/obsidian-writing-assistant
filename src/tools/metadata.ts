/**
 * Centralized display metadata for all tools.
 *
 * Provides icon names, human-readable labels, streaming status text, and
 * input extraction for the AgenticTimeline, StreamingRenderer, and
 * EditStreamingRenderer. Keeping these in one place ensures every tool
 * added to the definitions is also represented in the UI.
 */

import { VAULT_OPS_TOOL_NAMES } from "./vault-ops/definition";
import { EDIT_TOOL_NAMES } from "./editing/definition";

/** Obsidian icon name for each tool (used in AgenticTimeline). */
export const TOOL_ICONS: Record<string, string> = {
  semantic_search: "search",
  read_file: "file-text",
  get_outline: "list-tree",
  read_section: "text-select",
  list_directory: "folder",
  directory_tree: "folder-tree",
  search_files: "file-search",
  search_content: "text-search",
  get_backlinks: "link",
  get_outgoing_links: "external-link",
  find_notes_by_tag: "tag",
  get_frontmatter: "file-code",
  propose_edit: "pencil",
  insert_into_note: "list-plus",
  update_frontmatter: "file-code-2",
  write_file: "file-plus",
  create_directory: "folder-plus",
  move_file: "file-symlink",
  move_folder: "folder-symlink",
  trash_file: "trash-2",
  trash_folder: "folder-x",
  replace_in_vault: "replace",
  think: "brain",
};

/** Past-tense label for completed tool calls (used in AgenticTimeline). */
export const TOOL_LABELS: Record<string, string> = {
  semantic_search: "Searched vault",
  read_file: "Read note",
  get_outline: "Read outline",
  read_section: "Read section",
  list_directory: "Listed folder",
  directory_tree: "Explored tree",
  search_files: "Searched files",
  search_content: "Searched content",
  get_backlinks: "Found backlinks",
  get_outgoing_links: "Found outgoing links",
  find_notes_by_tag: "Found notes by tag",
  get_frontmatter: "Read frontmatter",
  propose_edit: "Proposed edit",
  insert_into_note: "Inserted into note",
  update_frontmatter: "Updated frontmatter",
  write_file: "Wrote file",
  create_directory: "Created folder",
  move_file: "Moved file",
  move_folder: "Moved folder",
  trash_file: "Trashed file",
  trash_folder: "Trashed folder",
  replace_in_vault: "Replaced across notes",
  think: "Thought",
};

/**
 * Present-tense label for a mutating step *while it is still awaiting approval*, so a
 * pending row reads as a proposal ("Write file") rather than asserting the action
 * already happened ("Wrote file") next to its approve/decline (docs/review
 * 2026-07-08-edit-tool-review-display F4). Only the vault-op tools need this: the base
 * timeline uses it for the pending placeholder, and {@link ../chat/messages/vaultReviewTimeline}
 * flips back to the past-tense {@link TOOL_LABELS} once the op is applied. Tools with no
 * entry fall back to {@link TOOL_LABELS} (read-only labels like "Read note" read fine in
 * either tense; the edit tools already phrase their labels as proposals).
 */
export const TOOL_PENDING_LABELS: Record<string, string> = {
  write_file: "Write file",
  create_directory: "Create folder",
  move_file: "Move file",
  move_folder: "Move folder",
  trash_file: "Trash file",
  trash_folder: "Trash folder",
  replace_in_vault: "Replace across notes",
};

/** Label for a tool-call step that is announced/pending (present tense where it matters). */
export function pendingToolLabel(toolName: string): string {
  return TOOL_PENDING_LABELS[toolName] ?? TOOL_LABELS[toolName] ?? toolName;
}

/** Status text shown inline during tool execution (streaming UI). */
export const TOOL_STATUS_LABELS: Record<string, string> = {
  semantic_search: "Searching vault...",
  read_file: "Reading note...",
  get_outline: "Reading outline...",
  read_section: "Reading section...",
  list_directory: "Listing folder...",
  directory_tree: "Exploring tree...",
  search_files: "Searching files...",
  search_content: "Searching content...",
  get_backlinks: "Finding backlinks...",
  get_outgoing_links: "Finding outgoing links...",
  find_notes_by_tag: "Finding notes by tag...",
  get_frontmatter: "Reading frontmatter...",
  propose_edit: "Composing edit...",
  insert_into_note: "Inserting into note...",
  update_frontmatter: "Updating frontmatter...",
  write_file: "Writing file...",
  create_directory: "Creating folder...",
  move_file: "Moving file...",
  move_folder: "Moving folder...",
  trash_file: "Trashing file...",
  trash_folder: "Trashing folder...",
  replace_in_vault: "Replacing text...",
  think: "Thinking...",
};

/**
 * Tools that change the vault or active document: every vault-op plus every edit
 * tool. Derived from the two source-of-truth name sets rather than re-listed, so a
 * newly added vault-op / edit tool is classified as mutating automatically (no drift,
 * the one place this used to break on a new tool). Mirrors the `destructiveHint` /
 * `idempotentHint` annotations; drives the orange "mutating" dot in the
 * {@link AgenticTimeline}, every other (read-only) tool keeps the default cyan.
 */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  ...VAULT_OPS_TOOL_NAMES,
  ...EDIT_TOOL_NAMES,
]);

/** True when a tool mutates the vault/document (vault op or edit), false for read-only tools. */
export function isMutatingTool(toolName: string | undefined): boolean {
  return toolName !== undefined && MUTATING_TOOL_NAMES.has(toolName);
}

/** Extract a human-readable summary of what a tool call operated on. */
export function extractToolInput(
  tc: { name: string; arguments: Record<string, unknown> },
): string | undefined {
  const args = tc.arguments;
  switch (tc.name) {
    case "semantic_search": return typeof args.query === "string" ? args.query : undefined;
    case "read_file": return typeof args.path === "string" ? args.path : undefined;
    case "get_outline": return typeof args.path === "string" ? args.path : undefined;
    case "read_section":
      return typeof args.path === "string" && typeof args.headingPath === "string"
        ? `${args.path} > ${args.headingPath}`
        : typeof args.path === "string"
          ? args.path
          : undefined;
    case "list_directory": return typeof args.path === "string" ? args.path : undefined;
    case "directory_tree": return typeof args.path === "string" ? args.path : undefined;
    case "search_files": return typeof args.pattern === "string" ? args.pattern : undefined;
    case "search_content": return typeof args.query === "string" ? args.query : undefined;
    case "get_backlinks": return typeof args.path === "string" ? args.path : undefined;
    case "get_outgoing_links": return typeof args.path === "string" ? args.path : undefined;
    case "find_notes_by_tag": return typeof args.tag === "string" ? args.tag : undefined;
    case "get_frontmatter": return Array.isArray(args.paths) ? `${args.paths.length} note(s)` : undefined;
    case "propose_edit": return typeof args.explanation === "string" ? args.explanation : undefined;
    case "insert_into_note": return typeof args.explanation === "string" ? args.explanation : undefined;
    case "update_frontmatter": return typeof args.explanation === "string" ? args.explanation : undefined;
    case "write_file": return typeof args.path === "string" ? args.path : undefined;
    case "create_directory": return typeof args.path === "string" ? args.path : undefined;
    case "move_file":
    case "move_folder":
      return typeof args.from === "string" && typeof args.to === "string"
        ? `${args.from} → ${args.to}`
        : undefined;
    case "trash_file": return typeof args.path === "string" ? args.path : undefined;
    case "trash_folder": return typeof args.path === "string" ? args.path : undefined;
    case "replace_in_vault":
      return typeof args.search === "string" && typeof args.replace === "string"
        ? `"${args.search}" → "${args.replace}"`
        : undefined;
    case "think": return typeof args.thought === "string" ? args.thought : undefined;
    default: return undefined;
  }
}

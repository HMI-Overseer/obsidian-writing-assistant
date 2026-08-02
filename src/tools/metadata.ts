/**
 * Centralized display metadata for all tools.
 *
 * Provides icon names, human-readable labels, streaming status text, and
 * input extraction for AssistantTurnView and review projections. Keeping these
 * in one place ensures every tool
 * added to the definitions is also represented in the UI.
 */

import type { VaultOperation } from "../vault-ops/types";
import { VAULT_OPS_TOOL_NAMES } from "./vault-ops/definition";
import { EDIT_TOOL_NAMES } from "./editing/definition";
import { MEMORY_MUTATION_TOOL_NAMES } from "./memory/definition";

/** Obsidian icon name for each tool in the assistant turn rail. */
export const TOOL_ICONS: Record<string, string> = {
  semantic_search: "search",
  read: "file-text",
  get_outline: "list-tree",
  list_directory: "folder",
  search_files: "file-search",
  search_content: "text-search",
  get_links: "link",
  find_notes_by_tag: "tag",
  get_frontmatter: "file-code",
  edit: "pencil",
  insert_into_note: "list-plus",
  update_frontmatter: "file-code-2",
  write_file: "file-plus",
  create_directory: "folder-plus",
  move: "file-symlink",
  trash: "trash-2",
  replace_in_vault: "replace",
  think: "brain",
  recall_memory: "brain",
  add_memory: "brain-circuit",
  forget_memory: "eraser",
  ask_user: "circle-help",
};

/** Past-tense label for completed tool calls. */
export const TOOL_LABELS: Record<string, string> = {
  semantic_search: "Searched vault",
  read: "Read note",
  get_outline: "Read outline",
  list_directory: "Listed folder",
  search_files: "Searched files",
  search_content: "Searched content",
  get_links: "Found links",
  find_notes_by_tag: "Found notes by tag",
  get_frontmatter: "Read frontmatter",
  edit: "Proposed edit",
  insert_into_note: "Inserted into note",
  update_frontmatter: "Updated frontmatter",
  write_file: "Wrote file",
  create_directory: "Created folder",
  move: "Moved",
  trash: "Trashed",
  replace_in_vault: "Replaced across notes",
  think: "Thought",
  recall_memory: "Recalled memory",
  add_memory: "Added memory",
  forget_memory: "Forgot memory",
  ask_user: "Asked for guidance",
};

/**
 * Display metadata for tool names the surface no longer advertises (RFC-0015).
 *
 * A conversation recorded before a rename holds the name that turn really called, and
 * that record is never rewritten: only the display lookups learn the old spelling, so
 * the saved turn renders exactly as it did the day it was written instead of falling
 * back to a raw name and the generic wrench. Nothing dispatches on these keys, and no
 * retired name is ever advertised to a model. The stage that retires a name adds its
 * row here, so this table is also the list of names that have ever been in the surface.
 */
const RETIRED_TOOL_DISPLAY: Record<string, { icon: string; label: string }> = {
  propose_edit: { icon: "pencil", label: "Proposed edit" },
  directory_tree: { icon: "folder-tree", label: "Explored tree" },
  get_backlinks: { icon: "link", label: "Found backlinks" },
  get_outgoing_links: { icon: "external-link", label: "Found outgoing links" },
  read_file: { icon: "file-text", label: "Read note" },
  read_section: { icon: "text-select", label: "Read section" },
  move_file: { icon: "file-symlink", label: "Moved file" },
  move_folder: { icon: "folder-symlink", label: "Moved folder" },
  trash_file: { icon: "trash-2", label: "Trashed file" },
  trash_folder: { icon: "folder-x", label: "Trashed folder" },
};

/** Icon for a recorded tool call, including one naming a retired tool. */
export function toolIcon(toolName: string): string {
  return TOOL_ICONS[toolName] ?? RETIRED_TOOL_DISPLAY[toolName]?.icon ?? "wrench";
}

/** Past-tense label for a recorded tool call, including one naming a retired tool. */
export function toolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? RETIRED_TOOL_DISPLAY[toolName]?.label ?? toolName;
}

/**
 * Present-tense label for a mutating step *while it is still awaiting approval*, so a
 * pending row reads as a proposal ("Write file") rather than asserting the action
 * already happened ("Wrote file") next to its approve/decline (docs/review/reviews
 * 2026-07-08-edit-tool-review-display F4). Only the vault-op tools need this: the base
 * timeline uses it for the pending placeholder, and {@link ../chat/messages/vaultReviewTimeline}
 * flips back to the past-tense {@link TOOL_LABELS} once the op is applied. Tools with no
 * entry fall back to {@link TOOL_LABELS} (read-only labels like "Read note" read fine in
 * either tense; the edit tools already phrase their labels as proposals).
 */
export const TOOL_PENDING_LABELS: Record<string, string> = {
  write_file: "Write file",
  create_directory: "Create folder",
  move: "Move",
  trash: "Trash",
  replace_in_vault: "Replace across notes",
  add_memory: "Add memory",
  forget_memory: "Forget memory",
  ask_user: "Waiting for your answer",
};

/** Label for a tool-call step that is announced/pending (present tense where it matters). */
export function pendingToolLabel(toolName: string): string {
  return TOOL_PENDING_LABELS[toolName] ?? toolLabel(toolName);
}

/**
 * The tool name behind each converted operation kind, used to label a vault-op row that
 * has no matched timeline step of its own ({@link ../chat/messages/vaultReviewTimeline}).
 * Two kinds share one tool wherever the tool resolves its kind from path state
 * (`write_file` picks create/overwrite, ADR-0004; `move` and `trash` pick their file or
 * folder kind the same way, RFC-0015), so this map is many-to-one in three places.
 *
 * The *keys* are typechecked against {@link VaultOperation}; the *values* are tool-name
 * strings nothing checks, so they live here beside the maps they index into rather than
 * beside their one consumer, and the display-metadata drift guard covers them.
 */
export const TOOL_NAME_BY_OP_KIND: Record<VaultOperation["kind"], string> = {
  create: "write_file",
  overwrite: "write_file",
  createDir: "create_directory",
  move: "move",
  trash: "trash",
  moveFolder: "move",
  trashFolder: "trash",
  replaceInVault: "replace_in_vault",
};

/**
 * Icon for a synthetic vault-op row, derived from the op's tool rather than listed a
 * second time: a matched step already draws {@link TOOL_ICONS}, and an unmatched one
 * must not be able to draw a different glyph for the same operation.
 */
export function opKindIcon(kind: VaultOperation["kind"]): string {
  return TOOL_ICONS[TOOL_NAME_BY_OP_KIND[kind]];
}

/** Status text shown inline during tool execution (streaming UI). */
export const TOOL_STATUS_LABELS: Record<string, string> = {
  semantic_search: "Searching vault...",
  read: "Reading note...",
  get_outline: "Reading outline...",
  list_directory: "Listing folder...",
  search_files: "Searching files...",
  search_content: "Searching content...",
  get_links: "Finding links...",
  find_notes_by_tag: "Finding notes by tag...",
  get_frontmatter: "Reading frontmatter...",
  edit: "Composing edit...",
  insert_into_note: "Inserting into note...",
  update_frontmatter: "Updating frontmatter...",
  write_file: "Writing file...",
  create_directory: "Creating folder...",
  move: "Moving...",
  trash: "Trashing...",
  replace_in_vault: "Replacing text...",
  think: "Thinking...",
  recall_memory: "Recalling memory...",
  add_memory: "Adding memory...",
  forget_memory: "Forgetting memory...",
  ask_user: "Waiting for your answer",
};

/**
 * Tools that change the vault or active document: every vault-op plus every edit
 * tool. Derived from the two source-of-truth name sets rather than re-listed, so a
 * newly added vault-op / edit tool is classified as mutating automatically (no drift,
 * the one place this used to break on a new tool). Mirrors the `destructiveHint` /
 * `idempotentHint` annotations; drives the orange "mutating" dot in the
 * {@link ../chat/messages/AssistantTurnView.AssistantTurnView}, every other
 * read-only tool keeps the default accent.
 */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  ...VAULT_OPS_TOOL_NAMES,
  ...EDIT_TOOL_NAMES,
  ...MEMORY_MUTATION_TOOL_NAMES,
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
    case "get_outline": return typeof args.path === "string" ? args.path : undefined;
    // One case serves `read` and both names it absorbed: the composition is
    // `read_section`'s, and `read_file` (which had no headingPath) falls to the path
    // alone, exactly as it did under its own case.
    case "read_file":
    case "read_section":
    case "read":
      return typeof args.path === "string" && typeof args.headingPath === "string"
        ? `${args.path} > ${args.headingPath}`
        : typeof args.path === "string"
          ? args.path
          : undefined;
    // Each retired name ({@link RETIRED_TOOL_DISPLAY}) keeps its case beside the tool that
    // absorbed it, so a saved turn that called it still shows its target rather than
    // losing the detail line.
    case "directory_tree":
    case "list_directory": return typeof args.path === "string" ? args.path : undefined;
    case "search_files": return typeof args.pattern === "string" ? args.pattern : undefined;
    case "search_content": return typeof args.query === "string" ? args.query : undefined;
    case "get_backlinks":
    case "get_outgoing_links":
    case "get_links": return typeof args.path === "string" ? args.path : undefined;
    case "find_notes_by_tag": return typeof args.tag === "string" ? args.tag : undefined;
    case "get_frontmatter": return Array.isArray(args.paths) ? `${args.paths.length} note(s)` : undefined;
    // "propose_edit" is retired ({@link RETIRED_TOOL_DISPLAY}); it stays here so a saved
    // turn that called it still shows its explanation rather than losing the detail line.
    case "propose_edit":
    case "edit": return typeof args.explanation === "string" ? args.explanation : undefined;
    case "insert_into_note": return typeof args.explanation === "string" ? args.explanation : undefined;
    case "update_frontmatter": return typeof args.explanation === "string" ? args.explanation : undefined;
    case "write_file": return typeof args.path === "string" ? args.path : undefined;
    case "create_directory": return typeof args.path === "string" ? args.path : undefined;
    case "move_file":
    case "move_folder":
    case "move":
      return typeof args.from === "string" && typeof args.to === "string"
        ? `${args.from} → ${args.to}`
        : undefined;
    case "trash_file":
    case "trash_folder":
    case "trash": return typeof args.path === "string" ? args.path : undefined;
    case "replace_in_vault":
      return typeof args.search === "string" && typeof args.replace === "string"
        ? `"${args.search}" → "${args.replace}"`
        : undefined;
    case "think": return typeof args.thought === "string" ? args.thought : undefined;
    case "recall_memory":
      return Array.isArray(args.names) ? `${args.names.length} memory name(s)` : undefined;
    case "add_memory":
    case "forget_memory":
      return typeof args.name === "string" ? args.name : undefined;
    case "ask_user":
      return Array.isArray(args.questions)
        ? `${args.questions.length} question(s)`
        : undefined;
    default: return undefined;
  }
}

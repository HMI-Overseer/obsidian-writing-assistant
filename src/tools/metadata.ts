/**
 * Centralized display metadata for all tools.
 *
 * Provides icon names, human-readable labels, streaming status text, and
 * input extraction for the AgenticTimeline, StreamingRenderer, and
 * EditStreamingRenderer. Keeping these in one place ensures every tool
 * added to the definitions is also represented in the UI.
 */

/** Obsidian icon name for each tool (used in AgenticTimeline). */
export const TOOL_ICONS: Record<string, string> = {
  semantic_search: "search",
  read_file: "file-text",
  list_directory: "folder",
  directory_tree: "folder-tree",
  search_files: "file-search",
  get_backlinks: "link",
  find_notes_by_tag: "tag",
  get_frontmatter: "file-code",
  propose_edit: "pencil",
  update_frontmatter: "file-code-2",
  think: "brain",
};

/** Past-tense label for completed tool calls (used in AgenticTimeline). */
export const TOOL_LABELS: Record<string, string> = {
  semantic_search: "Searched vault",
  read_file: "Read note",
  list_directory: "Listed folder",
  directory_tree: "Explored tree",
  search_files: "Searched files",
  get_backlinks: "Found backlinks",
  find_notes_by_tag: "Found notes by tag",
  get_frontmatter: "Read frontmatter",
  propose_edit: "Proposed edit",
  update_frontmatter: "Updated frontmatter",
  think: "Thought",
};

/** Status text shown inline during tool execution (streaming UI). */
export const TOOL_STATUS_LABELS: Record<string, string> = {
  semantic_search: "Searching vault...",
  read_file: "Reading note...",
  list_directory: "Listing folder...",
  directory_tree: "Exploring tree...",
  search_files: "Searching files...",
  get_backlinks: "Finding backlinks...",
  find_notes_by_tag: "Finding notes by tag...",
  get_frontmatter: "Reading frontmatter...",
  propose_edit: "Composing edit...",
  update_frontmatter: "Updating frontmatter...",
  think: "Thinking...",
};

/** Extract a human-readable summary of what a tool call operated on. */
export function extractToolInput(
  tc: { name: string; arguments: Record<string, unknown> },
): string | undefined {
  const args = tc.arguments;
  switch (tc.name) {
    case "semantic_search": return typeof args.query === "string" ? args.query : undefined;
    case "read_file": return typeof args.path === "string" ? args.path : undefined;
    case "list_directory": return typeof args.path === "string" ? args.path : undefined;
    case "directory_tree": return typeof args.path === "string" ? args.path : undefined;
    case "search_files": return typeof args.pattern === "string" ? args.pattern : undefined;
    case "get_backlinks": return typeof args.path === "string" ? args.path : undefined;
    case "find_notes_by_tag": return typeof args.tag === "string" ? args.tag : undefined;
    case "get_frontmatter": return Array.isArray(args.paths) ? `${args.paths.length} note(s)` : undefined;
    case "think": return typeof args.thought === "string" ? args.thought : undefined;
    default: return undefined;
  }
}

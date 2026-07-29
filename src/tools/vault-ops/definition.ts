import type { CanonicalToolDefinition } from "../types";
import type { VaultOpPolicy, GatedVaultOpClass } from "../../vault-ops/gateway";

// ---------------------------------------------------------------------------
// Vault-operation tools, produce a VaultOperationProposal for review.
//
// Each tool carries MCP `annotations` as descriptive risk metadata (ADR-0023) plus
// strategyHint / errorGuidance for the system prompt. They never touch disk in
// the loop: a call appends an intent to a per-turn proposal, applied only once
// gated and pre-flighted.
// ---------------------------------------------------------------------------

export const WRITE_FILE_TOOL: CanonicalToolDefinition = {
  name: "write_file",
  description:
    "Create a new note (or overwrite an existing one) at a vault-relative path. " +
    "The whole file content is replaced. The change is shown to the user for review before it is applied. " +
    "For targeted changes to an existing note's prose, prefer propose_edit instead of overwriting the whole file.",
  strategyHint:
    "create a new note at a vault path, or replace an existing note's full content. " +
    "Prefer propose_edit for small changes to an existing note.",
  errorGuidance:
    "If the path points at a folder, choose a file path or use create_directory. " +
    "Paths must be an Obsidian document, a Markdown note (.md) or a canvas (.canvas); other types are refused. " +
    "If the content was cut off by the output limit, re-issue the call with the complete file content.",
  annotations: { destructiveHint: true },
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Vault-relative path to an Obsidian document, a Markdown note (.md) or a canvas (.canvas), " +
          "e.g. 'Characters/Alice.md'. Other file types are refused. Missing parent folders are created automatically.",
      },
      content: {
        type: "string",
        description: "The complete file content to write. Replaces the file entirely when it exists.",
      },
    },
    required: ["path", "content"],
  },
};

export const CREATE_DIRECTORY_TOOL: CanonicalToolDefinition = {
  name: "create_directory",
  description:
    "Create a folder at a vault-relative path, including any missing parent folders. " +
    "Idempotent, does nothing if the folder already exists.",
  strategyHint: "create a folder before writing notes into it (idempotent).",
  errorGuidance: "If the path points at an existing file, choose a different folder path.",
  annotations: { idempotentHint: true },
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Vault-relative folder path (e.g., 'Characters/Minor').",
      },
    },
    required: ["path"],
  },
};

export const MOVE_FILE_TOOL: CanonicalToolDefinition = {
  name: "move_file",
  description:
    "Move or rename a note to a new vault-relative path. " +
    "All wikilinks and backlinks to the note are rewritten automatically. " +
    "The change is shown to the user for review before it is applied.",
  strategyHint:
    "move or rename a note; backlinks are rewritten automatically. Use to reorganize the vault.",
  errorGuidance:
    "If the destination already exists, choose a new name. " +
    "The destination must stay an Obsidian document (.md or .canvas), a move cannot change a note into another file type. " +
    "If the source does not exist, verify the path with list_directory or search_files.",
  annotations: { destructiveHint: true },
  parameters: {
    type: "object",
    properties: {
      from: {
        type: "string",
        description: "Current vault-relative path of the note (e.g., 'Inbox/Draft.md').",
      },
      to: {
        type: "string",
        description:
          "Destination vault-relative path, must be an Obsidian document (.md or .canvas), " +
          "e.g. 'Characters/Alice.md'. Missing parent folders are created automatically.",
      },
    },
    required: ["from", "to"],
  },
};

export const MOVE_FOLDER_TOOL: CanonicalToolDefinition = {
  name: "move_folder",
  description:
    "Move or rename an entire folder, with everything inside it, to a new vault-relative path. " +
    "All wikilinks and backlinks to the notes it contains are rewritten automatically. " +
    "Use this to reorganize the vault a whole folder at a time, instead of moving notes one by one. " +
    "The change is shown to the user for review before it is applied.",
  strategyHint:
    "move or rename a whole folder and its contents in one step; backlinks are rewritten automatically. " +
    "Prefer it over moving notes one by one to reorganize the vault.",
  errorGuidance:
    "If the destination already exists, choose a new name. " +
    "If the source is a single note rather than a folder, use move_file instead. " +
    "If the source does not exist, verify the path with list_directory.",
  annotations: { destructiveHint: true },
  parameters: {
    type: "object",
    properties: {
      from: {
        type: "string",
        description: "Current vault-relative path of the folder (e.g., 'Drafts/Act II').",
      },
      to: {
        type: "string",
        description:
          "Destination vault-relative folder path (e.g., 'Manuscript/Act II'). " +
          "Missing parent folders are created automatically.",
      },
    },
    required: ["from", "to"],
  },
};

export const TRASH_FILE_TOOL: CanonicalToolDefinition = {
  name: "trash_file",
  description:
    "Send a note to trash. Files only, folders are not accepted. " +
    "Honors the user's deleted-files preference (system trash or .trash). " +
    "The change is shown to the user for review before it is applied, and can be undone.",
  strategyHint: "send a single note to trash (files only). Honors the user's deleted-files preference.",
  errorGuidance:
    "If the path is a folder, trash_file does not apply, it targets files only. " +
    "If the note does not exist, verify the path first.",
  annotations: { destructiveHint: true },
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Vault-relative file path of the note to trash (e.g., 'Inbox/Obsolete.md').",
      },
    },
    required: ["path"],
  },
};

export const TRASH_FOLDER_TOOL: CanonicalToolDefinition = {
  name: "trash_folder",
  description:
    "Send a folder to trash when it holds no notes. Empty subfolders inside it are removed along with " +
    "it, so a whole husk of nested empty folders goes in a single call. A folder that still contains a " +
    "note anywhere inside is refused, and the error lists the notes so you can clear them first. " +
    "Use it to clean up the husk left behind after moving a folder's contents elsewhere. " +
    "Honors the user's deleted-files preference (system trash or .trash). " +
    "The change is shown to the user for review before it is applied, and can be undone.",
  strategyHint:
    "remove a folder that holds no notes (its empty subfolders go with it), e.g. the husk left after " +
    "moving its notes out. Refused, with the blocking notes listed, if any note remains inside.",
  errorGuidance:
    "If the folder still contains notes, the error lists them: move or trash those first, then trash the " +
    "folder in one call (empty subfolders need not be removed one by one). " +
    "If the path is a single note, use trash_file instead. If it does not exist, verify the path first.",
  annotations: { destructiveHint: true },
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Vault-relative path of the folder to trash (e.g., 'Drafts/Act II'). It must contain no notes, " +
          "though empty subfolders inside it are fine and are removed with it.",
      },
    },
    required: ["path"],
  },
};

export const REPLACE_IN_VAULT_TOOL: CanonicalToolDefinition = {
  name: "replace_in_vault",
  description:
    "Find and replace an exact piece of text across many notes in one operation, e.g. to rename a " +
    "term, character, or place everywhere it appears. Every matching note is rewritten and the whole " +
    "set of changes is shown to the user for review before anything is applied. " +
    "Use this for a vault-wide rename instead of editing notes one at a time; for a single passage in " +
    "one note use propose_edit, and never rewrite whole files with write_file just to change a term.",
  strategyHint:
    "rename or relabel an exact term across the whole vault (or one folder) in a single reviewable step, " +
    "prefer it over editing notes one by one. Use propose_edit for a single passage in one note.",
  errorGuidance:
    "If no occurrences are found, check spelling and case, or widen the scope, the search is literal, not " +
    "a pattern. If it would change too many unrelated matches, narrow it with a longer search string, set " +
    "wholeWord true, or limit path to a folder.",
  annotations: { destructiveHint: true },
  parameters: {
    type: "object",
    properties: {
      search: {
        type: "string",
        description:
          "The exact literal text to find (not a regular expression). Matched across note bodies, " +
          "every occurrence in every matching note is replaced.",
      },
      replace: {
        type: "string",
        description:
          "The replacement text, inserted verbatim. Use an empty string to delete the search text.",
      },
      path: {
        type: "string",
        description:
          "Optional vault-relative scope. Either a folder to limit the replace to (e.g. 'Lore'), " +
          "or a single note to replace within just that one file (e.g. 'Manuscript/Chapter 4.md'). " +
          "Omit to search the whole vault.",
      },
      caseSensitive: {
        type: "boolean",
        description: "Match case exactly. Defaults to false (case-insensitive).",
      },
      wholeWord: {
        type: "boolean",
        description:
          "Only match whole words, so 'cat' will not match inside 'category'. Defaults to false.",
      },
    },
    required: ["search", "replace"],
  },
};

/** All vault-operation tools, in the order they should appear in the API request. */
export const ALL_VAULT_OPS_TOOLS: CanonicalToolDefinition[] = [
  WRITE_FILE_TOOL,
  CREATE_DIRECTORY_TOOL,
  MOVE_FILE_TOOL,
  MOVE_FOLDER_TOOL,
  TRASH_FILE_TOOL,
  TRASH_FOLDER_TOOL,
  REPLACE_IN_VAULT_TOOL,
];

/** Set of vault-op tool names for fast membership checks in the tool loop. */
export const VAULT_OPS_TOOL_NAMES = new Set(ALL_VAULT_OPS_TOOLS.map((t) => t.name));

/**
 * Policy classes each tool can resolve to. `write_file` maps to *two* classes,
 * it picks `create` or `overwrite` at apply time from whether the path exists
 * (ADR-0004), so it stays usable as long as either is allowed.
 */
const TOOL_POLICY_CLASSES: Record<string, GatedVaultOpClass[]> = {
  write_file: ["create", "overwrite"],
  create_directory: ["createDir"],
  move_file: ["move"],
  trash_file: ["trash"],
  // Folder ops reuse the file siblings' gate class (moveFolder→move, trashFolder→trash,
  // see classOf), so denying "move"/"trash" detaches the folder tool too.
  move_folder: ["move"],
  trash_folder: ["trash"],
  // A vault-wide replace is gated as an overwrite (it rewrites file content), so it
  // stays available whenever overwrites are allowed, no separate policy knob.
  replace_in_vault: ["overwrite"],
};

/**
 * The vault-op tools a policy leaves usable: a `deny`-classed tool is
 * detached from lean and deferred tool sets so the model cannot discover a
 * capability it cannot use. A cache-stable schema superset is separately guarded
 * at runtime. A tool is dropped only when *every* class it can resolve to is denied, so
 * `write_file` survives whenever either `create` or `overwrite` is allowed.
 */
export function allowedVaultOpsTools(policy: VaultOpPolicy): CanonicalToolDefinition[] {
  return ALL_VAULT_OPS_TOOLS.filter((tool) =>
    (TOOL_POLICY_CLASSES[tool.name] ?? []).some((cls) => policy[cls] !== "deny"),
  );
}

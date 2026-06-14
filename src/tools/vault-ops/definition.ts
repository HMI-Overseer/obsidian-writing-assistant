import type { CanonicalToolDefinition } from "../types";
import type { VaultOpPolicy } from "../../vault-ops/gateway";
import type { VaultOpClass } from "../../vault-ops/types";

// ---------------------------------------------------------------------------
// Vault-operation tools — produce a VaultOperationProposal for review (spec §8).
//
// Each tool carries MCP `annotations` (the gateway reads them, spec §2.1) plus
// strategyHint / errorGuidance for the system prompt. They never touch disk in
// the loop: a call appends an intent to a per-turn proposal, applied only once
// gated and pre-flighted (spec §0).
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
    "If the content was cut off by the output limit, re-issue the call with the complete file content.",
  annotations: { destructiveHint: true },
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Vault-relative file path including extension (e.g., 'Characters/Vex.md'). " +
          "Missing parent folders are created automatically.",
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
    "Idempotent — does nothing if the folder already exists.",
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
          "Destination vault-relative path (e.g., 'Characters/Vex.md'). " +
          "Missing parent folders are created automatically.",
      },
    },
    required: ["from", "to"],
  },
};

export const TRASH_FILE_TOOL: CanonicalToolDefinition = {
  name: "trash_file",
  description:
    "Send a note to trash. Files only — folders are not accepted. " +
    "Honors the user's deleted-files preference (system trash or .trash). " +
    "The change is shown to the user for review before it is applied, and can be undone.",
  strategyHint: "send a single note to trash (files only). Honors the user's deleted-files preference.",
  errorGuidance:
    "If the path is a folder, trash_file does not apply — it targets files only. " +
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

/** All vault-operation tools, in the order they should appear in the API request. */
export const ALL_VAULT_OPS_TOOLS: CanonicalToolDefinition[] = [
  WRITE_FILE_TOOL,
  CREATE_DIRECTORY_TOOL,
  MOVE_FILE_TOOL,
  TRASH_FILE_TOOL,
];

/** Set of vault-op tool names for fast membership checks in the tool loop. */
export const VAULT_OPS_TOOL_NAMES = new Set(ALL_VAULT_OPS_TOOLS.map((t) => t.name));

/**
 * Policy classes each tool can resolve to. `write_file` maps to *two* classes —
 * it picks `create` or `overwrite` at apply time from whether the path exists
 * (spec §2.2) — so it stays usable as long as either is allowed.
 */
const TOOL_POLICY_CLASSES: Record<string, VaultOpClass[]> = {
  write_file: ["create", "overwrite"],
  create_directory: ["createDir"],
  move_file: ["move"],
  trash_file: ["trash"],
};

/**
 * The vault-op tools a policy leaves usable (spec §5): a `deny`-classed tool is
 * detached from the active set so the model is never offered a capability it
 * can't use — the same mechanism that drops `semantic_search` when its index is
 * cold. A tool is dropped only when *every* class it can resolve to is denied, so
 * `write_file` survives whenever either `create` or `overwrite` is allowed.
 */
export function allowedVaultOpsTools(policy: VaultOpPolicy): CanonicalToolDefinition[] {
  return ALL_VAULT_OPS_TOOLS.filter((tool) =>
    (TOOL_POLICY_CLASSES[tool.name] ?? []).some((cls) => policy[cls] !== "deny"),
  );
}

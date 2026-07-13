import type { VaultOpDisposition } from "../vault-ops/disposition";

/** JSON Schema subset for tool parameter definitions. */
export interface JsonSchemaProperty {
  /** Omitted only when {@link anyOf} carries the type alternatives instead. */
  type?: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  enum?: string[];
  /**
   * Type alternatives for a value that may take more than one shape (e.g. a
   * frontmatter value that is either a scalar string or an array of strings).
   * When present, `type` is omitted and each alternative is a full sub-schema.
   */
  anyOf?: JsonSchemaProperty[];
}

/**
 * MCP-standard tool annotations (ADR-0023; see
 * docs/02-architecture/components/tools/vault-write-surface.md).
 * Declarative risk metadata for definitions and future wire formatters. The plugin's
 * authorization gateway uses explicit converted operation classes, not these hints.
 * Not sent in direct-provider API bodies.
 */
export interface ToolAnnotations {
  /** Executes immediately, no gate (all vault read tools). */
  readOnlyHint?: boolean;
  /** Overwrite / move / trash, hard gate. */
  destructiveHint?: boolean;
  /** create_directory, soft gate (no-op if the folder already exists). */
  idempotentHint?: boolean;
  /** Reserved; unused here. */
  openWorldHint?: boolean;
}

/** Provider-agnostic tool definition. */
export interface CanonicalToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, JsonSchemaProperty>;
    required: string[];
  };
  /**
   * One-line hint used in the exploration strategy section of the system prompt.
   * Describes *when* to reach for this tool relative to others.
   * Not sent to the API, system-prompt generation only.
   */
  strategyHint?: string;
  /**
   * Static, prompt-level *strategy* for when this tool class errors, the general
   * move, authored once and surfaced in the error-handling section of the system
   * prompt ({@link ./vault/systemPrompt}). It is the complement of the *situated*
   * recovery a failed call carries on its result ({@link ToolResult.failure}): the
   * prompt says the strategy, the result says this call's specific fix. They do not
   * overlap. Not sent to the API, system-prompt generation only.
   */
  errorGuidance?: string;
  /**
   * MCP-standard risk annotations. Descriptive metadata, not the plugin's
   * authorization source; not sent to direct-provider APIs.
   */
  annotations?: ToolAnnotations;
}

/** A parsed tool call from a model response. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * A small, closed vocabulary of failure *kinds*, the machine-readable analogue of
 * what {@link ../vault-ops/disposition.VaultOpDisposition} is for mutation outcomes.
 * Its load-bearing use is driving the {@link toolFailure} builder: each kind maps to a
 * recovery-shaped sentence so every error names what failed *and* what to try next.
 * That recovery text in `content` is what reaches the model, the feedback loop is
 * complete without anything reading `kind` off the result. The `kind` is kept on the
 * result as a cheap typed handle for any future in-loop steering (e.g. don't retry a
 * `denied` tool); nothing branches on it yet.
 *
 * Kept small and exhaustive on purpose (the same discipline as `VaultOpDisposition`):
 *   - `not-found`, a named target doesn't exist (a path, note, or folder).
 *   - `invalid-args`, the call's arguments are missing or malformed.
 *   - `no-match`, the input was valid but nothing matched (an edit's search
 *                       text, a content query that blocks an action).
 *   - `ambiguous`, more than one candidate matched; the call can't choose.
 *   - `precondition`, a required state doesn't hold (wrong target, stale snapshot,
 *                       "this turn already edits another file").
 *   - `unavailable`, a capability can't run right now (no embedding backend, cold
 *                       index, unreachable model, missing execution context).
 *   - `denied`, policy forbids the action; retrying is pointless.
 *   - `failed`, the action ran but failed to complete (apply/IO error).
 */
export type ErrorKind =
  | "not-found"
  | "invalid-args"
  | "no-match"
  | "ambiguous"
  | "precondition"
  | "unavailable"
  | "denied"
  | "failed";

/**
 * Structured failure carried alongside {@link ToolResult.content}. `content` stays
 * the human/model sentence; `kind` is the stable code a consumer can branch on;
 * `recovery` is the situated next step the model acts on (also embedded in `content`).
 * Additive and optional, handlers populate it as they migrate to the contract, and
 * the MCP bridge flattens it to `content` + `isError`, so untouched paths behave as
 * before.
 */
export interface ToolFailure {
  kind: ErrorKind;
  /** One-line, situated, recovery-shaped next step. */
  recovery?: string;
}

/** Result returned by a tool handler. */
export interface ToolResult {
  /** Text content returned to the model. */
  content: string;
  /** Whether this tool only reads data (true) or proposes document changes (false). */
  isReadOnly: boolean;
  /** Whether the tool execution failed. */
  isError?: boolean;
  /**
   * Structured failure detail when `isError` is true. Optional, its absence on an
   * error result means "not yet migrated to the contract," not "no failure."
   */
  failure?: ToolFailure;
  /**
   * The reviewed mutation's real disposition, set by the live vault-op / edit review
   * ({@link ../chat/actions/liveVaultReview}). Read at the tool-result choke points
   * so a step persists the outcome (a decline resolves `isError: false`, so nothing
   * else distinguishes it). Absent on read tools and unreviewed calls. Not sent to
   * the model, the disposition already lives in {@link content}.
   */
  disposition?: VaultOpDisposition;
}

/**
 * In-loop reviewer for a single vault-op / edit tool call: blocks on the user's
 * approve/decline and returns the real disposition as a {@link ToolResult}.
 *
 * The narrow contract the Claude Code MCP path depends on, so the service layer
 * stays decoupled from the concrete chat-UI coordinator (`LiveVaultReview`) that
 * implements it. Expressed entirely in tool-domain types, with no Obsidian or
 * chat dependency, so it lives here next to {@link ToolCall} / {@link ToolResult}.
 */
export interface VaultOpReviewer {
  /** Resolve a single vault-op call, bound to the given tool-call/timeline id. */
  resolveOne(call: ToolCall, toolCallId: string): Promise<ToolResult>;
  /** Resolve a single edit call (the edit-channel sibling of {@link resolveOne}). */
  resolveEditOne(call: ToolCall, toolCallId: string): Promise<ToolResult>;
}

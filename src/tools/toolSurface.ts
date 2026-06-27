import type { CanonicalToolDefinition, ToolResult } from "./types";
import type { VaultOpPolicy } from "../vault-ops/gateway";
import { ALL_VAULT_TOOLS, CORE_VAULT_TOOLS, VAULT_TOOL_NAMES } from "./vault/definition";
import { ALL_EDIT_TOOLS } from "./editing/definition";
import { ALL_VAULT_OPS_TOOLS, allowedVaultOpsTools } from "./vault-ops/definition";
import { THINK_TOOL, THINK_TOOL_NAME } from "./think/definition";
import { toolFailure } from "./toolFailure";

/**
 * The canonical tool-surface resolver (prompt-cache design §6.1.1/§6.1.4/§6.1.5).
 *
 * One module, read by every path, so the surfaces cannot drift (the defect that
 * produced the `semantic_search` silent-failure). The mode-varying decision that
 * actually matters for safety is the **write gate**: which mutating tools (edit +
 * vault-ops) a mode permits. That lives in {@link resolveModeWriteTools} and is the
 * single source consumed by both local materialization and the cloud allow-list.
 *
 * **Reads are not mode-gated on the cloud paths.** The whole point of the design is
 * to give cloud providers the full tool surface (bloat is addressed by Layer 2
 * progressive disclosure, not by per-mode read-subsetting), so a cloud provider may
 * call any read tool in any mode (see {@link cloudAllowedToolSet}). Local providers
 * keep their lean per-mode read tier ({@link resolveModeReadTools}) because they pay
 * no caching cost and benefit from a small menu; that tier is local-only.
 *
 * While the three modes coexist (Phases 1-2) the write gate keys on mode; once the
 * selector collapses into the approval posture (§6.3) the residual gate is the
 * per-class deny policy plus the posture's apply-vs-ask routing. Portable: no
 * Obsidian, no disk, so it unit-tests in isolation.
 */

/** Inputs that decide a request's tool surface. `editSurface` = edit mode with tool-based editing on. */
export interface ToolSurfaceOptions {
  /** True in edit mode (vs plan/conversation). */
  editMode: boolean;
  /** The `preferToolUse` setting: edit via tools rather than the prose fallback. */
  preferToolUse: boolean;
  /** Vault-op approval policy; a `deny`-classed write is excluded from every surface. */
  policy: VaultOpPolicy;
  /** Whether the `think` meta tool is offered (false for LM Studio and Claude Code). */
  useThinkTool: boolean;
}

/** The edit tool surface is active only in edit mode with tool-based editing preferred. */
function isEditSurface(opts: ToolSurfaceOptions): boolean {
  return opts.editMode && opts.preferToolUse;
}

/**
 * The mutating tools a mode permits, policy-filtered. **The single source for the
 * write gate**, consumed by local materialization ({@link resolveLocalToolSet}) and
 * the cloud allow-list ({@link cloudAllowedToolSet}) alike, so the two can never
 * diverge on what is allowed to write. Edit tools come first, then the vault-op
 * superset minus any `deny`-classed op (ADR-0003). Outside the edit surface there
 * are no writes at all (plan/conversation, and edit without tool-based editing).
 */
export function resolveModeWriteTools(opts: ToolSurfaceOptions): CanonicalToolDefinition[] {
  if (!isEditSurface(opts)) return [];
  const editTools = opts.policy.edit === "deny" ? [] : ALL_EDIT_TOOLS;
  return [...editTools, ...allowedVaultOpsTools(opts.policy)];
}

/**
 * The lean per-mode **read** tier, materialized only by local providers. The edit
 * surface narrows to the core primitives (a focused document task); every other
 * mode gets the full read suite. Cloud providers ignore this and allow all reads
 * ({@link cloudAllowedToolSet}).
 */
export function resolveModeReadTools(opts: ToolSurfaceOptions): CanonicalToolDefinition[] {
  return isEditSurface(opts) ? CORE_VAULT_TOOLS : ALL_VAULT_TOOLS;
}

/**
 * The lean tool set a local provider emits for a mode: its read tier + its write
 * tier + `think`, in the order the request expects. Reproduces the historical
 * per-mode materialization byte-for-byte, so local behavior is unchanged.
 */
export function resolveLocalToolSet(opts: ToolSurfaceOptions): CanonicalToolDefinition[] {
  return [
    ...resolveModeReadTools(opts),
    ...resolveModeWriteTools(opts),
    ...(opts.useThinkTool ? [THINK_TOOL] : []),
  ];
}

/**
 * The tools a **cloud** path allows the model to actually call this turn: every
 * read tool (unrestricted, in every mode) + the mode's permitted writes + `think`.
 * The cloud emits the full stable superset ({@link CLOUD_STABLE_TOOL_SET}) for cache
 * stability, but enforces this narrower allow-list at the execution gate; a tool not
 * in it is refused with {@link modeNotAllowedFailure}, never executed. Reuses
 * {@link resolveModeWriteTools} so the write gate matches local exactly.
 */
export function cloudAllowedToolSet(opts: ToolSurfaceOptions): CanonicalToolDefinition[] {
  return [
    ...ALL_VAULT_TOOLS,
    ...resolveModeWriteTools(opts),
    ...(opts.useThinkTool ? [THINK_TOOL] : []),
  ];
}

/** Names of the cloud allow-list, for the runtime gate (tool loop / MCP `callTool`). */
export function cloudAllowedToolNames(opts: ToolSurfaceOptions): string[] {
  return cloudAllowedToolSet(opts).map((tool) => tool.name);
}

/**
 * The full, deterministic, mode/policy-invariant tool surface emitted on the direct
 * Anthropic path (Layer 1). Holding it byte-identical across modes is what keeps the
 * `cache_control` prefix warm through plan/chat/edit switches. It is the union of
 * every read, edit, and vault-op tool plus `think`; mode and policy are enforced at
 * the runtime allow-list, not by shrinking this block.
 */
export const CLOUD_STABLE_TOOL_SET: CanonicalToolDefinition[] = [
  ...ALL_VAULT_TOOLS,
  ...ALL_EDIT_TOOLS,
  ...ALL_VAULT_OPS_TOOLS,
  THINK_TOOL,
];

/**
 * The Claude Code analogue of {@link CLOUD_STABLE_TOOL_SET}: the same superset minus
 * `think` (which is never bridged over MCP, §6.2.5). Advertising it unchanged across
 * mode + RAG-availability flips is what keeps the live session alive instead of
 * cold-rebuilding (the `toolNames` fingerprint field stops drifting).
 */
export const CLAUDE_CODE_STABLE_TOOL_SET: CanonicalToolDefinition[] = [
  ...ALL_VAULT_TOOLS,
  ...ALL_EDIT_TOOLS,
  ...ALL_VAULT_OPS_TOOLS,
];

/**
 * The recovery-shaped refusal returned when the runtime allow-list blocks a call the
 * stable surface advertised but the current mode does not permit (the spin-guard
 * precedent, {@link ../chat/actions/toolLoop.applyIdenticalCallGuard}). Only mutating
 * tools ever reach this gate (reads are always allowed), so the wording tells the
 * model to drop the call rather than re-issue it.
 */
export function modeNotAllowedFailure(name: string): ToolResult {
  const isReadOnly = VAULT_TOOL_NAMES.has(name) || name === THINK_TOOL_NAME;
  return toolFailure({
    kind: "precondition",
    what: `${name} is not available in the current mode`,
    recovery: `do not retry it; the current session does not permit ${name}, so continue without it`,
    isReadOnly,
  });
}

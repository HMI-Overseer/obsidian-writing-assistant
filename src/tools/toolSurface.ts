import type { CanonicalToolDefinition, ToolResult } from "./types";
import type { VaultOpPolicy } from "../vault-ops/gateway";
import type { ApprovalPosture } from "../shared/types";
import { ALL_VAULT_TOOLS, VAULT_TOOL_NAMES } from "./vault/definition";
import { ALL_EDIT_TOOLS } from "./editing/definition";
import { ALL_VAULT_OPS_TOOLS, allowedVaultOpsTools } from "./vault-ops/definition";
import { THINK_TOOL, THINK_TOOL_NAME } from "./think/definition";
import { toolFailure } from "./toolFailure";

/**
 * The canonical tool-surface resolver (prompt-cache design §6.1.1/§6.1.4/§6.1.5, §6.3).
 *
 * One module, read by every path, so the surfaces cannot drift (the defect that
 * produced the `semantic_search` silent-failure). The session-varying decision that
 * matters for safety is the **write gate**: which mutating tools (edit + vault-ops)
 * are offered. That lives in {@link resolveWriteTools} and is the single source
 * consumed by both local materialization and the cloud allow-list, so the two can
 * never diverge on what may write.
 *
 * Writes are no longer gated by an edit "mode" (the plan/chat/edit selector is gone,
 * §6.3); they are offered whenever the {@link ApprovalPosture} + per-class
 * {@link VaultOpPolicy} permit. Under the default `ask` posture a `deny`-classed
 * write is excluded (the hard read-only guarantee, ADR-0003); under the `auto`
 * posture ("Edit automatically") the policy is overruled and every write is offered
 * so it can auto-apply at the gate. Reads are never gated on the cloud paths, and the
 * local read tier is now the full read suite too (the per-mode read-narrowing went
 * away with the modes). Portable: no Obsidian, no disk, so it unit-tests in isolation.
 */

/** Inputs that decide a request's tool surface. */
export interface ToolSurfaceOptions {
  /** Session approval posture. `auto` ("Edit automatically") re-offers deny-classed writes. */
  posture: ApprovalPosture;
  /** Vault-op approval policy; under the `ask` posture a `deny`-classed write is excluded. */
  policy: VaultOpPolicy;
  /** Whether the `think` meta tool is offered (false for LM Studio and Claude Code). */
  useThinkTool: boolean;
}

/**
 * The mutating tools the session permits, policy-filtered. **The single source for
 * the write gate**, consumed by local materialization ({@link resolveLocalToolSet})
 * and the cloud allow-list ({@link cloudAllowedToolSet}) alike. Under the default
 * `ask` posture, `deny`-classed writes are excluded (edit via `policy.edit`, vault-ops
 * via {@link allowedVaultOpsTools}). Under the `auto` posture the per-class policy is
 * overruled, so the full edit + vault-op superset is offered (and auto-applies at the
 * gate, see {@link resolveGate}).
 */
export function resolveWriteTools(opts: ToolSurfaceOptions): CanonicalToolDefinition[] {
  if (opts.posture === "auto") {
    return [...ALL_EDIT_TOOLS, ...ALL_VAULT_OPS_TOOLS];
  }
  const editTools = opts.policy.edit === "deny" ? [] : ALL_EDIT_TOOLS;
  return [...editTools, ...allowedVaultOpsTools(opts.policy)];
}

/**
 * The tools the session permits the model to actually call: every read tool
 * (unrestricted) + the posture/policy's permitted writes + `think`. Local providers
 * emit exactly this set; cloud emits the full stable superset
 * ({@link CLOUD_STABLE_TOOL_SET}) for cache stability but enforces this narrower
 * allow-list at the execution gate.
 */
function permittedTools(opts: ToolSurfaceOptions): CanonicalToolDefinition[] {
  return [
    ...ALL_VAULT_TOOLS,
    ...resolveWriteTools(opts),
    ...(opts.useThinkTool ? [THINK_TOOL] : []),
  ];
}

/**
 * The lean tool set a local provider emits: the full read suite + the permitted
 * writes + `think`. Local has no caching incentive, so the emitted set already is the
 * allowed set (no separate runtime allow-list).
 */
export function resolveLocalToolSet(opts: ToolSurfaceOptions): CanonicalToolDefinition[] {
  return permittedTools(opts);
}

/**
 * The tools a **cloud** path allows the model to actually call this turn (every read
 * + permitted writes + `think`). The cloud emits the full stable superset for cache
 * stability but enforces this allow-list at the execution gate; a tool not in it is
 * refused with {@link toolNotAllowedFailure}, never executed. Identical to the local
 * set ({@link resolveLocalToolSet}) now that reads are unrestricted on both.
 */
export function cloudAllowedToolSet(opts: ToolSurfaceOptions): CanonicalToolDefinition[] {
  return permittedTools(opts);
}

/** Names of the cloud allow-list, for the runtime gate (tool loop / MCP `callTool`). */
export function cloudAllowedToolNames(opts: ToolSurfaceOptions): string[] {
  return cloudAllowedToolSet(opts).map((tool) => tool.name);
}

/**
 * The full, deterministic, posture/policy-invariant tool surface emitted on the direct
 * Anthropic path (Layer 1). Holding it byte-identical across postures and policy is
 * what keeps the `cache_control` prefix warm; the posture/policy are enforced at the
 * runtime allow-list, not by shrinking this block. It is the union of every read,
 * edit, and vault-op tool plus `think`.
 */
export const CLOUD_STABLE_TOOL_SET: CanonicalToolDefinition[] = [
  ...ALL_VAULT_TOOLS,
  ...ALL_EDIT_TOOLS,
  ...ALL_VAULT_OPS_TOOLS,
  THINK_TOOL,
];

/**
 * The Claude Code analogue of {@link CLOUD_STABLE_TOOL_SET}: the same superset minus
 * `think` (which is never bridged over MCP, §6.2.5). Advertising it unchanged keeps
 * the live session alive instead of cold-rebuilding (the `toolNames` fingerprint field
 * stops drifting).
 */
export const CLAUDE_CODE_STABLE_TOOL_SET: CanonicalToolDefinition[] = [
  ...ALL_VAULT_TOOLS,
  ...ALL_EDIT_TOOLS,
  ...ALL_VAULT_OPS_TOOLS,
];

/**
 * The recovery-shaped refusal returned when the runtime allow-list blocks a call the
 * stable surface advertised but the session does not permit (a `deny`-classed write
 * under the `ask` posture). Built on the spin-guard precedent
 * ({@link ../chat/actions/toolLoop.applyIdenticalCallGuard}). Only mutating tools ever
 * reach this gate (reads are always allowed), so the wording tells the model to drop
 * the call rather than re-issue it.
 */
export function toolNotAllowedFailure(name: string): ToolResult {
  const isReadOnly = VAULT_TOOL_NAMES.has(name) || name === THINK_TOOL_NAME;
  return toolFailure({
    kind: "precondition",
    what: `${name} is not permitted in this session`,
    recovery: `do not retry it; the current approval settings do not allow ${name}, so continue without it`,
    isReadOnly,
  });
}

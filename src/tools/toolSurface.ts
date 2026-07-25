import type { CanonicalToolDefinition, ToolResult } from "./types";
import type { VaultOpPolicy } from "../vault-ops/gateway";
import type { ApprovalPosture } from "../shared/types";
import {
  ALL_VAULT_TOOLS,
  VAULT_TOOL_NAMES,
  CORE_VAULT_TOOLS,
  GET_OUTLINE_TOOL,
  READ_SECTION_TOOL,
} from "./vault/definition";
import { ALL_EDIT_TOOLS } from "./editing/definition";
import { ALL_VAULT_OPS_TOOLS, allowedVaultOpsTools } from "./vault-ops/definition";
import { THINK_TOOL, THINK_TOOL_NAME } from "./think/definition";
import {
  ALL_MEMORY_TOOLS,
  MEMORY_MUTATION_TOOL_NAMES,
  RECALL_MEMORY_TOOL,
  allowedMemoryTools,
} from "./memory/definition";
import { toolFailure } from "./toolFailure";

/**
 * The canonical tool-surface resolver (prompt-cache design section 6.1.1/section 6.1.4/section 6.1.5, section 6.3).
 *
 * One module, read by every path, so the surfaces cannot drift (the defect that
 * produced the `semantic_search` silent-failure). The session-varying decision that
 * matters for safety is the **write gate**: which mutating tools (edit + vault-ops)
 * are offered. That lives in {@link resolveWriteTools} and is the single source
 * consumed by both local materialization and the cloud allow-list, so the two can
 * never diverge on what may write.
 *
 * Writes are no longer gated by an edit "mode" (the plan/chat/edit selector is gone,
 * section 6.3); they are offered whenever the {@link ApprovalPosture} + per-class
 * {@link VaultOpPolicy} permit. Under the default `ask` posture a `deny`-classed
 * write is excluded (the hard read-only guarantee, ADR-0023); under the `auto`
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
  /** Whether the memory family exists on this request's tool surface. */
  memoriesEnabled: boolean;
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
    ...(opts.memoriesEnabled ? allowedMemoryTools(opts.policy, opts.posture) : []),
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
 * `think` (which is never bridged over MCP, section 6.2.5). Advertising it unchanged keeps
 * the live session alive instead of cold-rebuilding (the `toolNames` fingerprint field
 * stops drifting).
 */
export const CLAUDE_CODE_STABLE_TOOL_SET: CanonicalToolDefinition[] = [
  ...ALL_VAULT_TOOLS,
  ...ALL_EDIT_TOOLS,
  ...ALL_VAULT_OPS_TOOLS,
];

/** Feature-conditional Layer 1 superset. The flag is its only varying input. */
export function claudeCodeStableToolSet(
  memoriesEnabled: boolean,
): CanonicalToolDefinition[] {
  return memoriesEnabled
    ? [...CLAUDE_CODE_STABLE_TOOL_SET, ...ALL_MEMORY_TOOLS]
    : CLAUDE_CODE_STABLE_TOOL_SET;
}

/** Feature-conditional Anthropic Layer 1 superset. The flag is its only varying input. */
export function cloudStableToolSet(
  memoriesEnabled: boolean,
): CanonicalToolDefinition[] {
  return [
    ...claudeCodeStableToolSet(memoriesEnabled),
    THINK_TOOL,
  ];
}

/*
 * Layer 2, progressive disclosure (the bloat fix). Settled in ADR-0009 and the
 * prompt-cache design section 6.2.5: under tool-search deferral the always-loaded surface
 * shrinks to a small core of retrieval / navigation primitives, and the long tail
 * (the rest of the reads + every write) loads on demand. On the direct `anthropic`
 * path the core is non-deferred and the tail carries `defer_loading`; on Claude Code
 * the core is marked `alwaysLoad` and the tail is left deferrable.
 *
 * The core is held SMALL on purpose. Deferred tools are excluded from the cached
 * prefix and appended inline (as `tool_reference` blocks) only when discovered, so
 * they never void the cache and cost nothing turn over turn. The core, by contrast,
 * stays in the prefix every turn, so each tool kept here is a permanent always-on
 * tax (Problem 2) and a permanent draw on tool-selection budget (Problem 3). The unit
 * tripwire that used to fire when the whole catalogue crossed 40 tools now guards this
 * core size instead.
 */

/**
 * The non-deferred Layer-2 core reads: the retrieval / navigation primitives kept
 * always-loaded on both billed paths (section 6.2.5). It is {@link CORE_VAULT_TOOLS}
 * (list_directory, semantic_search, search_content, read_file) plus the section-level
 * {@link GET_OUTLINE_TOOL} / {@link READ_SECTION_TOOL} pair. Everything else, the read
 * tail and every write, defers.
 */
export const CORE_READ_TOOLS: CanonicalToolDefinition[] = [
  ...CORE_VAULT_TOOLS,
  GET_OUTLINE_TOOL,
  READ_SECTION_TOOL,
  RECALL_MEMORY_TOOL,
];

/** Names of {@link CORE_READ_TOOLS}, for the wire-layer defer / `alwaysLoad` split. */
export const CORE_READ_TOOL_NAMES: ReadonlySet<string> = new Set(
  CORE_READ_TOOLS.map((tool) => tool.name),
);

/**
 * Whether `name` is a non-deferred Layer-2 core read, always loaded on both billed
 * paths. Consumed by the Claude Code MCP bridge to mark the core `alwaysLoad`
 * ({@link ../api/sdk/sdkMcpServer}) and by the direct-API tool formatter to decide
 * which emitted tools carry `defer_loading` ({@link ./formatters/anthropic}).
 */
export function isCoreReadTool(name: string): boolean {
  return CORE_READ_TOOL_NAMES.has(name);
}

/**
 * The non-deferred tool NAMES on the direct `anthropic` path: the Layer-2 core reads
 * plus `think` (always-loaded on the native agentic path, section 6.2.5; never bridged to
 * Claude Code). The native tool-search entry is non-deferred by construction at the
 * wire layer and is not a {@link CanonicalToolDefinition}, so it is not listed here.
 * Every emitted tool whose name is absent from this set carries `defer_loading: true`.
 */
export function anthropicNonDeferredToolNames(
  memoriesEnabled = false,
): Set<string> {
  const names = memoriesEnabled
    ? CORE_READ_TOOL_NAMES
    : new Set(
        [...CORE_READ_TOOL_NAMES].filter(
          (name) => name !== RECALL_MEMORY_TOOL.name,
        ),
      );
  return new Set([...names, THINK_TOOL_NAME]);
}

/**
 * The Layer-2 tool set emitted on the direct `anthropic` path (ADR-0009 / section 6.2.5): the
 * non-deferred core reads + `think`, then the deferred tail (the remaining reads + the
 * posture/policy-permitted writes). The wire layer
 * ({@link ../tools/formatters/anthropic.formatAnthropicToolsWithSearch}) marks every name
 * outside {@link anthropicNonDeferredToolNames} with `defer_loading`, so the tail loads on
 * demand and sits outside the cached prefix; the small non-deferred core is what stays
 * warm turn over turn.
 *
 * The tail's writes come from {@link resolveWriteTools}, so a `deny`-classed write under
 * the `ask` posture is absent from this catalogue entirely. It is therefore never
 * discoverable via tool search, closing the open seam at the discovery layer rather than
 * only refusing it at execution (ADR-0009 open seam / {@link toolNotAllowedFailure},
 * ADR-0023). The runtime allow-list ({@link cloudAllowedToolNames}) still guards execution
 * as defense in depth.
 */
export function anthropicLayer2ToolSet(opts: ToolSurfaceOptions): CanonicalToolDefinition[] {
  const coreReads = opts.memoriesEnabled
    ? CORE_READ_TOOLS
    : CORE_READ_TOOLS.filter((tool) => tool.name !== RECALL_MEMORY_TOOL.name);
  const tailReads = ALL_VAULT_TOOLS.filter((tool) => !isCoreReadTool(tool.name));
  const memoryMutations = opts.memoriesEnabled
    ? allowedMemoryTools(opts.policy, opts.posture).filter((tool) =>
        MEMORY_MUTATION_TOOL_NAMES.has(tool.name),
      )
    : [];
  return [
    ...coreReads,
    ...(opts.useThinkTool ? [THINK_TOOL] : []),
    ...tailReads,
    ...resolveWriteTools(opts),
    ...memoryMutations,
  ];
}

/**
 * The recovery-shaped refusal returned when the runtime allow-list blocks a call the
 * stable surface advertised but the session does not permit (a `deny`-classed write
 * under the `ask` posture). Built on the spin-guard precedent
 * ({@link ../chat/actions/toolLoop.applyIdenticalCallGuard}). Only mutating tools ever
 * reach this gate (reads are always allowed), so the wording tells the model to drop
 * the call rather than re-issue it.
 */
export function toolNotAllowedFailure(name: string): ToolResult {
  const isReadOnly =
    VAULT_TOOL_NAMES.has(name) ||
    name === THINK_TOOL_NAME ||
    name === RECALL_MEMORY_TOOL.name;
  return toolFailure({
    kind: "precondition",
    what: `${name} is not permitted in this session`,
    recovery: `do not retry it; the current approval settings do not allow ${name}, so continue without it`,
    isReadOnly,
  });
}

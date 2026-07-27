import type { App } from "obsidian";
import type { AgenticStep, PluginSettings } from "../shared/types";
import type { MemoryService } from "../memory/MemoryService";
import type { RagService } from "../rag/ragService";
import type { McpToolCallContext, McpToolProvider } from "../mcp/VaultMcpServer";
import { ASK_TOOL_NAMES } from "../tools/ask/definition";
import {
  askCancellationFailure,
  askConcurrentFailure,
  askInvalidRequestFailure,
  askSkippedSiblingFailure,
  buildAskUserResult,
} from "../tools/ask/result";
import { EDIT_TOOL_NAMES } from "../tools/editing/definition";
import {
  MEMORY_MUTATION_TOOL_NAMES,
  MEMORY_TOOL_NAMES,
} from "../tools/memory/definition";
import { executeMemoryTool, type MemoryToolContext } from "../tools/memory/handlers";
import { normalizeVaultToolCall } from "../tools/paths";
import { effectIntentFor } from "../shared/generationAudit";
import { effectBoundaryRefusal, toolFailure } from "../tools/toolFailure";
import {
  claudeCodeStableToolSet,
  toolNotAllowedFailure,
} from "../tools/toolSurface";
import type {
  CanonicalToolDefinition,
  ToolCall,
  ToolResult,
  VaultOpReviewer,
} from "../tools/types";
import { VAULT_TOOL_NAMES } from "../tools/vault/definition";
import { executeVaultTool } from "../tools/vault/handlers";
import { VAULT_OPS_TOOL_NAMES } from "../tools/vault-ops/definition";
import type { VaultOpDisposition } from "../vault-ops/disposition";
import {
  AskInteractionPreconditionError,
  AskInteractionValidationError,
} from "../chat/interactions/AskInteractionCoordinator";
import { generateId } from "../utils";
import {
  effectBoundaryFor,
  isCallbackToken,
  type CallbackRefusal,
  type ClaudeCodeEffectBoundary,
  type ClaudeCodeGenerationLease,
  type ClaudeCodeRunSlot,
} from "./ClaudeCodeGenerationLease";

/**
 * The Claude Code callback surface: one MCP tool provider bound to one
 * {@link ClaudeCodeRunSlot} (RFC-0011 phase 5, plan section 8.3).
 *
 * An MCP server captures its provider for the lifetime of the transport it serves,
 * and on the persistent path that transport outlives many generations. So the
 * provider closes over the *slot*, and the slot is what a generation installs its
 * lease into. Everything a callback reads, the allow-list, the review owner, the
 * ask responder, the active-file context, the lifecycle sink, comes from the lease
 * it captured at entry; nothing is read from a mutable service field.
 *
 * There is deliberately no fallback executor here. The pre-phase-5 provider fell
 * back to a collect-for-later path when no review owner was installed, which is
 * exactly how a callback from a finished generation reached an executor at all. A
 * mutation with no owner is refused now.
 */

/** Long-lived services the executors behind the callback surface need. */
export interface ClaudeCodeCallbackDeps {
  app: App;
  getSettings: () => PluginSettings;
  getRagService: () => RagService;
  getMemoryService: () => MemoryService;
  persistSettings: () => Promise<void>;
}

/**
 * Builds the provider one callback surface advertises and executes. The advertised
 * catalogue is the constant stable superset in every mode, so `toolNames` never
 * drifts and a live session survives a posture switch (prompt-cache design
 * section 6.1.1); the lease's allow-list decides what may actually run.
 */
export function createClaudeCodeCallbackProvider(
  deps: ClaudeCodeCallbackDeps,
  slot: ClaudeCodeRunSlot,
): McpToolProvider {
  return {
    listTools: (): CanonicalToolDefinition[] =>
      claudeCodeStableToolSet(deps.getSettings().memoriesEnabled),
    callTool: async (
      rawCall: ToolCall,
      context?: McpToolCallContext,
    ): Promise<ToolResult> => {
      // Admission first, and with no `await` before it (settled decision 19). A
      // callback that gets past here owns a lease for as long as it runs; one that
      // does not learns only that this surface stopped answering.
      const admission = slot.admit();
      if (!isCallbackToken(admission)) {
        return refusedCallback(rawCall.name, admission);
      }
      try {
        return await routeCallback(deps, admission.lease, rawCall, context);
      } finally {
        admission.release();
      }
    },
  };
}

/**
 * Everything after admission, under exactly one lease.
 *
 * Mirrors the pre-phase-5 ordering so the timeline behaviour is unchanged:
 * normalize the call's paths, settle correlation, claim or refuse the ask barrier,
 * emit the `start` event, execute, and emit the `end` event from a `finally` so a
 * thrown executor never leaves a stuck pending placeholder.
 */
async function routeCallback(
  deps: ClaudeCodeCallbackDeps,
  lease: ClaudeCodeGenerationLease,
  rawCall: ToolCall,
  context: McpToolCallContext | undefined,
): Promise<ToolResult> {
  // Translate absolute paths to vault-relative up front so the executor, the
  // review, and the timeline all see the same resolved path.
  const call = normalizeVaultToolCall(deps.app, rawCall);
  const correlation = resolveCorrelation(lease, call, context);
  const toolCallId = correlation === "provider_id" ? call.id : "";
  if (correlation === "none" && requiresExactToolCorrelation(call.name)) {
    return toolFailure({
      kind: "precondition",
      what: `tool "${call.name}" cannot run without exact provider correlation`,
      recovery: "retry after the Claude Code bridge supplies its provider tool-use ID",
    });
  }

  const isAsk = ASK_TOOL_NAMES.has(call.name);
  let claimedAsk = false;
  let barrierResult: ToolResult | null = null;
  if (isAsk) {
    claimedAsk = lease.claimAsk();
    if (!claimedAsk) barrierResult = askConcurrentFailure();
  } else if (lease.askPending) {
    barrierResult = askSkippedSiblingFailure(call.name);
  }

  if (correlation === "provider_id") {
    lease.context.lifecycle?.({ phase: "start", toolName: call.name, toolCallId });
  }
  let isError = true;
  // The result text the model received, carried to the timeline so a failed call
  // shows its error. Defaults cover a thrown executor (no result object).
  let content = "The tool threw an unexpected error.";
  // The reviewed op's real disposition, when present, so the persisted step records
  // the outcome for the cold-rebuild replay digest (ADR-0016).
  let disposition: VaultOpDisposition | undefined;
  try {
    if (barrierResult) {
      content = barrierResult.content;
      return barrierResult;
    }
    const result = await executeUnderLease(deps, lease, call, toolCallId);
    isError = result.isError ?? false;
    content = result.content;
    disposition = result.disposition;
    return result;
  } finally {
    if (claimedAsk) lease.releaseAsk();
    if (correlation === "provider_id") {
      lease.context.lifecycle?.({
        phase: "end",
        toolName: call.name,
        args: call.arguments,
        isError,
        content,
        toolCallId,
        disposition,
        ...(isAsk && { askStatus: askStatusFromResult(isError, content) }),
      });
    }
  }
}

/**
 * Routes one admitted call to its executor under the lease's own context.
 *
 * The allow-list gate runs first and is the primary deny gate (prompt-cache design
 * section 6.1.4): the surface advertises the full superset, so a call this
 * generation does not permit is refused before it runs.
 */
function executeUnderLease(
  deps: ClaudeCodeCallbackDeps,
  lease: ClaudeCodeGenerationLease,
  call: ToolCall,
  toolCallId: string,
): Promise<ToolResult> {
  if (!lease.context.allowedTools.has(call.name)) {
    return Promise.resolve(toolNotAllowedFailure(call.name));
  }
  if (ASK_TOOL_NAMES.has(call.name)) {
    return executeAskUser(lease, call, toolCallId);
  }
  if (VAULT_TOOL_NAMES.has(call.name)) {
    // Read-only vault work has no irreversible boundary (settled decision 20), so
    // it crosses nothing. The active note is the one the generation captured, not
    // whichever pane happens to be focused when the callback lands.
    return Promise.resolve(
      executeVaultTool(call, {
        app: deps.app,
        ragService: deps.getRagService(),
        activeFilePath: lease.context.activeFilePath || undefined,
      }),
    );
  }
  if (MEMORY_MUTATION_TOOL_NAMES.has(call.name)) {
    return reviewedMutation(lease, "memory_review", call, (review) =>
      review.resolveMemoryOne(call, toolCallId),
    );
  }
  if (MEMORY_TOOL_NAMES.has(call.name)) {
    return Promise.resolve(executeMemoryTool(call, memoryToolContext(deps)));
  }
  if (EDIT_TOOL_NAMES.has(call.name)) {
    return reviewedMutation(lease, "edit_review", call, (review) =>
      review.resolveEditOne(call, toolCallId),
    );
  }
  if (VAULT_OPS_TOOL_NAMES.has(call.name)) {
    return reviewedMutation(lease, "vault_op_review", call, (review) =>
      review.resolveOne(call, toolCallId),
    );
  }
  return Promise.resolve(
    toolFailure({
      kind: "invalid-args",
      what: `unknown tool "${call.name}"`,
      recovery: "call one of the advertised tools instead",
    }),
  );
}

/**
 * Every mutating family goes through its own named effect boundary (settled
 * decision 20), and none of them has a path that runs without the review owner
 * that authorized it.
 */
async function reviewedMutation(
  lease: ClaudeCodeGenerationLease,
  boundary: ClaudeCodeEffectBoundary,
  call: ToolCall,
  resolve: (review: VaultOpReviewer) => Promise<ToolResult>,
): Promise<ToolResult> {
  const review = lease.context.review;
  if (!review) {
    return toolFailure({
      kind: "precondition",
      what: "this run has no review owner, so the change cannot be proposed",
      recovery: "do not retry it; the generation that authorized this call has ended",
      isReadOnly: false,
    });
  }
  const intent = effectIntentFor(boundary, call, {
    kind: "provider_id",
    toolCallId: call.id,
  });
  if (!(await lease.crossEffectBoundary(boundary, intent))) {
    return effectBoundaryRefusal(boundary);
  }
  try {
    return await resolve(review);
  } finally {
    // The outcome reconciles under the same lease that admitted the callback,
    // before the result reaches the model, so the audit is never behind what the
    // model has already been told.
    await lease.reconcileEffect(intent);
  }
}

async function executeAskUser(
  lease: ClaudeCodeGenerationLease,
  call: ToolCall,
  toolCallId: string,
): Promise<ToolResult> {
  const responder = lease.context.askResponder;
  if (!responder) return askConcurrentFailure();
  const intent = effectIntentFor("ask_interaction", call, {
    kind: "provider_id",
    toolCallId: call.id,
  });
  if (!(await lease.crossEffectBoundary("ask_interaction", intent))) {
    return askCancellationFailure("stopped");
  }

  try {
    const answers = await responder.ask(call.arguments, {
      interactionId: generateId(),
      toolCallId,
      signal: lease.context.askSignal ?? new AbortController().signal,
    });
    return buildAskUserResult(answers);
  } catch (error) {
    if (error instanceof AskInteractionValidationError) {
      return askInvalidRequestFailure(error.issue);
    }
    if (error instanceof AskInteractionPreconditionError) {
      return askConcurrentFailure();
    }
    if (isAbortError(error)) {
      return askCancellationFailure("stopped");
    }
    throw error;
  }
}

/** Settles the correlation this call arrived with and records it on the lease. */
function resolveCorrelation(
  lease: ClaudeCodeGenerationLease,
  call: ToolCall,
  context: McpToolCallContext | undefined,
): "provider_id" | "none" {
  const requested =
    context?.toolCorrelation ?? (call.id.length > 0 ? "provider_id" : "none");
  const correlation =
    requested === "provider_id" && call.id.trim().length > 0
      ? "provider_id"
      : "none";
  lease.observeCorrelation(correlation);
  return correlation;
}

/**
 * The bounded refusal a callback gets when this surface is not answering. It names
 * why the surface is closed and nothing else: no review state, no interaction
 * state, and no hint about whatever generation owns the surface now.
 */
function refusedCallback(toolName: string, refusal: CallbackRefusal): ToolResult {
  return toolFailure({
    kind: "precondition",
    what: `this run's tool surface is closed (${refusal})`,
    recovery: "stop calling tools; the generation that authorized this call has ended",
    isReadOnly: effectBoundaryFor(toolName) === null,
  });
}

function memoryToolContext(deps: ClaudeCodeCallbackDeps): MemoryToolContext {
  return {
    memoryService: deps.getMemoryService(),
    getMemories: () => deps.getSettings().memories,
    saveSettings: deps.persistSettings,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Which tools may not run without the provider's own tool-use ID. Every one of
 * them binds a review row or an interaction to an exact identity, so a call with
 * no ID has nothing to bind to.
 */
function requiresExactToolCorrelation(toolName: string): boolean {
  return effectBoundaryFor(toolName) !== null;
}

function askStatusFromResult(
  isError: boolean,
  content: string,
): NonNullable<AgenticStep["askStatus"]> {
  if (!isError) return "completed";
  return content.includes("ask_cancelled") ? "cancelled" : "skipped";
}

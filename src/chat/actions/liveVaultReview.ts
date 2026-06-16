import { type App, type MetadataCache, type TFile, normalizePath } from "obsidian";
import type { ToolCall, ToolResult } from "../../tools/types";
import type {
  AppliedVaultOpRecord,
  ReviewableVaultOp,
  VaultOperation,
  VaultOperationProposal,
} from "../../vault-ops/types";
import { diskState, diskFingerprint, readContentOrNull } from "../../vault-ops/apply";
import { applyVaultOpBatch } from "../../vault-ops/applyBatch";
import { resolveGate, type VaultOpPolicy } from "../../vault-ops/gateway";
import { summarizeOp } from "../../vault-ops/summary";
import { dispositionMessage, type VaultOpDisposition } from "../../vault-ops/disposition";
import { toVaultOperations, type ConversionProbes } from "../../tools/vault-ops/conversion";
import { buildPendingOverlay } from "../../tools/vault-ops/handlers";
import { makeResolver } from "../../tools/vault-ops/overlay";
import {
  VaultReviewTimelineView,
  type VaultReviewCallbacks,
} from "../messages/vaultReviewTimeline";
import { generateId } from "../../utils";

interface ExtendedMetadataCache extends MetadataCache {
  getBacklinksForFile(file: TFile): { data: Record<string, unknown[]> };
}

/** A converted op classified by how it must resolve. */
type Entry =
  | { call: ToolCall; kind: "error"; result: ToolResult }
  | { call: ToolCall; kind: "satisfied"; reviewable: ReviewableVaultOp }
  | { call: ToolCall; kind: "auto"; reviewable: ReviewableVaultOp }
  | { call: ToolCall; kind: "ask"; reviewable: ReviewableVaultOp };

/** A parked ask op: its promise resolves when the user (or a cancel) decides. */
interface PendingResolution {
  resolve: (outcome: { disposition: VaultOpDisposition; reason?: string }) => void;
  promise: Promise<{ disposition: VaultOpDisposition; reason?: string }>;
}

export interface LiveVaultReviewOptions {
  app: App;
  /** The streaming bubble's timeline element — where the review decorates steps. */
  timelineEl: HTMLElement;
  policy: VaultOpPolicy;
}

/**
 * In-loop vault-op review coordinator (in-loop-tool-approval-blocking-flow).
 *
 * Owns one growing {@link VaultOperationProposal}, mounts {@link VaultReviewTimelineView}
 * live on the streaming bubble, applies `auto` ops immediately, and — for `ask`
 * ops — hands the tool loop a promise that resolves only when the user approves or
 * declines. The model is thus blocked at the `ask`-gated tool turn and receives the
 * *real* disposition as that call's tool result.
 *
 * One resolved state, two consumers: the timeline mutates each op's
 * {@link VaultOpStatus} (UI truth) and reports the terminal decision via
 * `onOpResolved`; this coordinator turns that into the tool result. The tool result
 * can never assert an outcome the timeline doesn't already hold.
 *
 * Shared by both executors: the plugin tool loop calls {@link resolveRound} once per
 * round; the Claude Code MCP path calls {@link resolveOne} per tool call.
 */
export class LiveVaultReview {
  private readonly app: App;
  private readonly timelineEl: HTMLElement;
  private readonly policy: VaultOpPolicy;

  private readonly proposal: VaultOperationProposal;
  private appliedRecord: AppliedVaultOpRecord | null = null;
  /** All vault-op calls seen so far — the intent overlay later rounds resolve against. */
  private readonly accumulatedCalls: ToolCall[] = [];
  /** Per-turn count of ops resolved to `auto` (feeds the gateway circuit breaker). */
  private autoSoFar = 0;
  /** opId → its parked resolution, for `ask` ops awaiting a click. */
  private readonly pending = new Map<string, PendingResolution>();
  /** Serializes registration/auto-apply so concurrent calls can't race the overlay. */
  private lock: Promise<void> = Promise.resolve();

  constructor(opts: LiveVaultReviewOptions) {
    this.app = opts.app;
    this.timelineEl = opts.timelineEl;
    this.policy = opts.policy;
    this.proposal = { id: generateId(), ops: [], createdAt: Date.now() };
  }

  /** Resolve a round of vault-op calls (plugin loop). Blocks until every `ask` op decides. */
  async resolveRound(
    calls: ToolCall[],
    stoppedForMaxTokens = false,
  ): Promise<Array<{ tc: ToolCall; result: ToolResult }>> {
    if (calls.length === 0) return [];

    const results = new Map<string, ToolResult>();

    // Registration + auto-apply run under the lock so the overlay, autoSoFar, and
    // the applied record stay consistent across concurrent callers. Parking on the
    // `ask` promises happens *outside* the lock so a held op never blocks the next
    // round's registration.
    const askEntries = await this.runExclusive(async () => {
      const entries = await this.register(calls, stoppedForMaxTokens);
      this.remount();

      for (const e of entries) {
        if (e.kind === "error") results.set(e.call.id, e.result);
        else if (e.kind === "satisfied") {
          results.set(e.call.id, dispoResult(e.reviewable.op, "satisfied"));
        }
      }

      const autoEntries = entries.filter((e): e is Extract<Entry, { kind: "auto" }> => e.kind === "auto");
      if (autoEntries.length > 0) {
        await this.applyAuto(autoEntries, results);
        this.remount();
      }

      return entries.filter((e): e is Extract<Entry, { kind: "ask" }> => e.kind === "ask");
    });

    await Promise.all(
      askEntries.map(async (e) => {
        const parked = this.pending.get(e.reviewable.id);
        if (!parked) return;
        const { disposition, reason } = await parked.promise;
        results.set(e.call.id, dispoResult(e.reviewable.op, disposition, reason));
      }),
    );

    return calls.map((c) => ({ tc: c, result: results.get(c.id) ?? cancelledFallback(c) }));
  }

  /** Resolve a single vault-op call (Claude Code MCP path). */
  async resolveOne(call: ToolCall, toolCallId: string): Promise<ToolResult> {
    // Use toolCallId as the op's source id so the review binds to the same timeline
    // step the MCP tool-lifecycle events tag with `data-tool-call-id`.
    const [resolved] = await this.resolveRound([{ ...call, id: toolCallId }]);
    return resolved.result;
  }

  /** The accumulated proposal for finalization to persist, or null if empty. */
  getProposal(): VaultOperationProposal | null {
    return this.proposal.ops.length > 0 ? this.proposal : null;
  }

  /** The applied record (auto + approved ops) for finalization to persist. */
  getAppliedRecord(): AppliedVaultOpRecord | null {
    return this.appliedRecord;
  }

  /**
   * Resolve every outstanding `ask` op as `cancelled` (abort / new user turn), so a
   * parked turn can't leak a hung await. Ops are left `pending` so the user can still
   * decide later via the finalized review surface — graceful fallback to async review.
   */
  cancelPending(): void {
    for (const [, parked] of this.pending) {
      parked.resolve({ disposition: "cancelled" });
    }
    this.pending.clear();
  }

  // -----------------------------------------------------------------------

  /** Convert + gate a batch, append reviewable ops, and park `ask` resolutions. */
  private async register(calls: ToolCall[], stoppedForMaxTokens: boolean): Promise<Entry[]> {
    const overlay = buildPendingOverlay(this.app, this.accumulatedCalls);
    const resolve = makeResolver(overlay, (p) => diskState(this.app, p));

    // Pre-read trash snapshots (async) so conversion stays synchronous, mirroring
    // buildVaultOpProposal: a trashed file's snapshot is what its inverse recreates.
    const snapshots = new Map<string, string>();
    for (const tc of calls) {
      if (tc.name === "trash_file" && typeof tc.arguments.path === "string") {
        const content = await readContentOrNull(this.app, tc.arguments.path);
        if (content !== null) snapshots.set(normalizePath(tc.arguments.path), content);
      }
    }

    const probes: ConversionProbes = {
      resolve,
      fingerprint: (p) => diskFingerprint(this.app, p),
      readContent: (p) => snapshots.get(normalizePath(p)) ?? null,
    };

    const { ops, sources, satisfied, errors } = toVaultOperations(calls, probes, {
      stoppedForMaxTokens,
    });
    this.accumulatedCalls.push(...calls);

    const opByCall = new Map<string, { op: VaultOperation; satisfied: boolean }>();
    ops.forEach((op, i) => opByCall.set(sources[i], { op, satisfied: satisfied[i] }));
    const errByCall = new Map(errors.map((e) => [e.toolCallId, e.error]));

    const entries: Entry[] = [];
    for (const call of calls) {
      const found = opByCall.get(call.id);
      if (!found) {
        const error = errByCall.get(call.id) ?? "could not convert operation";
        entries.push({
          call,
          kind: "error",
          result: { content: `Invalid ${call.name} arguments: ${error}`, isReadOnly: false, isError: true },
        });
        continue;
      }

      const { op, satisfied: isSatisfied } = found;
      const gate = isSatisfied ? "auto" : resolveGate(op, this.policy, this.autoSoFar);
      if (gate === "deny") {
        // Denied tools are filtered upstream (Phase 4); guard anyway.
        entries.push({
          call,
          kind: "error",
          result: { content: `${call.name} is not permitted by the current policy.`, isReadOnly: false, isError: true },
        });
        continue;
      }
      if (gate === "auto" && !isSatisfied) this.autoSoFar++;

      const reviewable: ReviewableVaultOp = {
        id: generateId(),
        op,
        gate,
        status: isSatisfied ? "satisfied" : "pending",
        summary: summarizeOp(op),
        sourceToolCallId: call.id,
      };
      if (op.kind === "move") reviewable.linkImpact = this.backlinkCount(op.from);
      this.proposal.ops.push(reviewable);

      if (isSatisfied) {
        entries.push({ call, kind: "satisfied", reviewable });
      } else if (gate === "auto") {
        entries.push({ call, kind: "auto", reviewable });
      } else {
        this.park(reviewable.id);
        entries.push({ call, kind: "ask", reviewable });
      }
    }
    return entries;
  }

  /** Apply auto-gated ops as one all-or-nothing batch and fill their results. */
  private async applyAuto(
    autoEntries: Array<Extract<Entry, { kind: "auto" }>>,
    results: Map<string, ToolResult>,
  ): Promise<void> {
    const batch = autoEntries.map((e) => ({ id: e.reviewable.id, op: e.reviewable.op }));
    const res = await applyVaultOpBatch(this.app, batch);
    if (res.ok) {
      for (const e of autoEntries) {
        e.reviewable.status = "applied";
        results.set(e.call.id, dispoResult(e.reviewable.op, "auto-applied"));
      }
      this.mergeRecord(res.applied);
    } else {
      const reason = res.conflicts[0]?.reason ?? res.error ?? "operation failed";
      for (const e of autoEntries) {
        e.reviewable.status = "failed";
        results.set(e.call.id, dispoResult(e.reviewable.op, "failed", reason));
      }
    }
  }

  /** Create the parked promise for an `ask` op, keyed by op id. */
  private park(opId: string): void {
    let resolve!: PendingResolution["resolve"];
    const promise = new Promise<{ disposition: VaultOpDisposition; reason?: string }>((r) => {
      resolve = r;
    });
    this.pending.set(opId, { resolve, promise });
  }

  /** The timeline reported a terminal user decision — resolve the parked promise. */
  private handleResolved(opId: string, disposition: "applied" | "declined"): void {
    const parked = this.pending.get(opId);
    if (!parked) return;
    this.pending.delete(opId);
    parked.resolve({ disposition });
  }

  /** Re-mount the review over the current proposal. Idempotent (cleanPriorDecorations). */
  private remount(): void {
    const callbacks: VaultReviewCallbacks = {
      onOpsChanged: () => {
        /* proposal mutated in place; persistence happens at finalization. */
      },
      onApplied: (record) => {
        this.appliedRecord = record;
      },
      onUndone: () => {
        this.appliedRecord = null;
      },
      onOpResolved: (opId, disposition) => this.handleResolved(opId, disposition),
    };
    new VaultReviewTimelineView({
      timelineEl: this.timelineEl,
      app: this.app,
      proposal: this.proposal,
      callbacks,
      existingRecord: this.appliedRecord ?? undefined,
      autoApply: false,
    });
  }

  private mergeRecord(applied: Array<{ opId: string; inverse: VaultOperation }>): void {
    if (!this.appliedRecord) {
      this.appliedRecord = {
        proposalId: this.proposal.id,
        applied: [...applied],
        appliedAt: Date.now(),
      };
    } else {
      this.appliedRecord.applied = [...this.appliedRecord.applied, ...applied];
      this.appliedRecord.appliedAt = Date.now();
    }
  }

  private backlinkCount(path: string): number {
    const file = this.app.vault.getFileByPath(normalizePath(path));
    if (!file) return 0;
    const backlinks = (this.app.metadataCache as ExtendedMetadataCache).getBacklinksForFile(file);
    return Object.keys(backlinks?.data ?? {}).length;
  }

  private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function dispoResult(
  op: VaultOperation,
  disposition: VaultOpDisposition,
  reason?: string,
): ToolResult {
  return {
    content: dispositionMessage(op, disposition, reason),
    isReadOnly: false,
    isError: disposition === "failed",
  };
}

/** A call with no result is a parked op cancelled before it decided. */
function cancelledFallback(call: ToolCall): ToolResult {
  return { content: `${call.name} review was interrupted; still pending.`, isReadOnly: false };
}

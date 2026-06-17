import { type App, type Component, type MetadataCache, type TFile, normalizePath } from "obsidian";
import type { ToolCall, ToolResult } from "../../tools/types";
import type {
  AppliedVaultOpRecord,
  ReviewableVaultOp,
  VaultOperation,
  VaultOperationProposal,
} from "../../vault-ops/types";
import { diskState, diskFingerprint, readContentOrNull } from "../../vault-ops/apply";
import { applyVaultOpBatch } from "../../vault-ops/applyBatch";
import { resolveGate, resolveEditGate, type VaultOpPolicy } from "../../vault-ops/gateway";
import { summarizeOp } from "../../vault-ops/summary";
import {
  dispositionMessage,
  editDispositionMessage,
  type EditOpKind,
  type VaultOpDisposition,
} from "../../vault-ops/disposition";
import { toVaultOperations, type ConversionProbes } from "../../tools/vault-ops/conversion";
import { buildPendingOverlay } from "../../tools/vault-ops/handlers";
import { makeResolver } from "../../tools/vault-ops/overlay";
import {
  VaultReviewTimelineView,
  type VaultReviewCallbacks,
} from "../messages/vaultReviewTimeline";
import type {
  AppliedEditRecord,
  DiffHunk,
  EditBlock,
  EditProposal,
  EditStatus,
} from "../../editing/editTypes";
import { resolveEdits } from "../../editing/diffEngine";
import { EditReviewController } from "../../editing/EditReviewController";
import type { InlineDiffManager } from "../../editing/inlineDiff/InlineDiffManager";
import { DiffReviewPanel } from "../messages/DiffReviewPanel";
import { convertToolCallToEditBlock } from "../../tools/editing/conversion";
import { resolveStructuralEditBlocks } from "../../tools/editing/handlers";
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

/**
 * Dependencies for the edit channel — present only in edit mode. Edits are vault
 * ops too, but their apply path is the {@link EditReviewController} and their
 * renderer is the {@link DiffReviewPanel} + in-note overlay (not the timeline),
 * so the coordinator needs a host to mount the live diff and the overlay manager
 * to light up the in-note view.
 */
export interface LiveEditReviewDeps {
  /** Container (in the bubble body) where the live diff panel mounts during the loop. */
  host: HTMLElement;
  /** Owner component for markdown render-child cleanup. */
  owner: Component;
  /** The shared overlay manager — the second renderer over the same controller. */
  inlineDiff: InlineDiffManager;
  /** Resolver tuning from settings (context lines, min confidence). */
  resolveOptions: { contextLines: number; minConfidence: number };
}

export interface LiveVaultReviewOptions {
  app: App;
  /** The streaming bubble's timeline element — where the review decorates steps. */
  timelineEl: HTMLElement;
  policy: VaultOpPolicy;
  /** Edit-channel dependencies. Absent outside edit mode. */
  edit?: LiveEditReviewDeps;
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
  /**
   * opId / hunkId → its parked resolution, for `ask` ops/edits awaiting a click.
   * Shared by both channels: file ops resolve via the timeline, edits via the
   * controller subscription. Keys are all `generateId()`, so they never collide.
   */
  private readonly pending = new Map<string, PendingResolution>();
  /** Serializes registration/auto-apply so concurrent calls can't race the overlay. */
  private lock: Promise<void> = Promise.resolve();

  // --- Edit channel state (in-document edits; see resolveEdits). -----------
  private readonly editDeps?: LiveEditReviewDeps;
  /** The single edit proposal accumulated across the turn's rounds, or null until the first hunk. */
  private editProposal: EditProposal | null = null;
  /** One controller for the whole turn — the single apply owner; the panel re-renders over it. */
  private editController: EditReviewController | null = null;
  /** The live diff panel, re-rendered (destroy + recreate) per round over {@link editController}. */
  private editPanel: DiffReviewPanel | null = null;
  private editAppliedRecord: AppliedEditRecord | null = null;
  /** The one note this turn edits — fixed by the first resolved edit (one file per turn). */
  private editTargetPath: string | null = null;

  constructor(opts: LiveVaultReviewOptions) {
    this.app = opts.app;
    this.timelineEl = opts.timelineEl;
    this.policy = opts.policy;
    this.editDeps = opts.edit;
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

  /**
   * Resolve a single edit call (Claude Code MCP path). The edit-channel sibling of
   * {@link resolveOne}: blocks on the user's accept/reject and returns the real
   * disposition, so Claude Code edits review in-loop just like the plugin loop.
   */
  async resolveEditOne(call: ToolCall, toolCallId: string): Promise<ToolResult> {
    const [resolved] = await this.resolveEdits([{ ...call, id: toolCallId }]);
    return resolved.result;
  }

  /**
   * Resolve a round of edit calls (`propose_edit` / `update_frontmatter`). Each
   * call is resolved in-loop with the real three-tier {@link resolveEdits} (not a
   * cheap exact pre-flight), gated by the `edit` policy, and blocks on the user
   * when `ask` — returning the *real* disposition as that call's tool result. A
   * confidence-0 no-match is reported honestly as `failed` (concern C), never a
   * silent drop.
   */
  async resolveEdits(calls: ToolCall[]): Promise<Array<{ tc: ToolCall; result: ToolResult }>> {
    if (calls.length === 0) return [];
    const deps = this.editDeps;
    if (!deps) {
      return calls.map((tc) => ({ tc, result: editError(tc, "edit review context unavailable") }));
    }

    const results = new Map<string, ToolResult>();
    type Parked = { callId: string; hunkId: string; kind: EditOpKind; path: string };

    // Registration + auto-apply run under the shared lock so the per-turn auto
    // budget and the controller stay consistent with the file-op channel; parking
    // on `ask` edits happens outside so a held edit never blocks the next round.
    const toPark = await this.runExclusive(async () => {
      const docCache = new Map<string, string>();
      const autoApplied: Parked[] = [];
      const parked: Parked[] = [];

      for (const call of calls) {
        const kind: EditOpKind = call.name === "update_frontmatter" ? "frontmatter" : "edit";
        const block = convertToolCallToEditBlock(call);
        if (!block) {
          results.set(call.id, editError(call, "could not parse edit arguments"));
          continue;
        }

        // The model names its target via the required `path` arg (no active-doc
        // fallback) — so an edit lands on the file it read, not whatever pane is open.
        if (!block.targetPath) {
          results.set(
            call.id,
            editError(call, "missing required 'path' — pass the vault-relative path of the note to edit"),
          );
          continue;
        }
        const file = this.app.vault.getFileByPath(normalizePath(block.targetPath));
        if (!file) {
          results.set(
            call.id,
            editError(call, `file not found: "${block.targetPath}" — check the path, or use write_file to create it`),
          );
          continue;
        }

        // One file per turn: the first resolved edit fixes the target; a different
        // file is rejected with guidance to do it in a later turn.
        if (this.editTargetPath && this.editTargetPath !== file.path) {
          results.set(
            call.id,
            editError(
              call,
              `this turn already edits "${this.editTargetPath}" — edit "${file.path}" in a separate message`,
            ),
          );
          continue;
        }

        let docText = docCache.get(file.path);
        if (docText === undefined) {
          docText = await this.app.vault.read(file);
          docCache.set(file.path, docText);
        }

        const resolvedBlock = await this.resolveStructural(block, file.path);
        const [resolved] = resolveEdits([resolvedBlock], docText, deps.resolveOptions);
        if (!resolved || resolved.confidence === 0) {
          // Concern C: honest no-match. The model self-corrects on this result.
          results.set(call.id, {
            content: editDispositionMessage(
              kind,
              file.path,
              "failed",
              "no location matched the search text; re-read the file and retry",
            ),
            isReadOnly: false,
            isError: true,
          });
          continue;
        }

        const gate = resolveEditGate(this.policy, file.path, this.autoSoFar);
        if (gate === "deny") {
          results.set(call.id, editError(call, "edits are denied by the current policy"));
          continue;
        }

        const controller = this.ensureEditController(file.path, docText);
        const hunk: DiffHunk = { id: generateId(), resolvedEdit: resolved, status: "pending" };
        controller.proposal.hunks.push(hunk);

        if (gate === "auto") {
          this.autoSoFar++;
          autoApplied.push({ callId: call.id, hunkId: hunk.id, kind, path: file.path });
        } else {
          this.park(hunk.id);
          parked.push({ callId: call.id, hunkId: hunk.id, kind, path: file.path });
        }
      }

      if (this.editController) this.renderEditPanel();

      for (const a of autoApplied) {
        await this.editController?.accept(a.hunkId);
        const applied = this.editController?.getStatus(a.hunkId) === "accepted";
        results.set(a.callId, {
          content: editDispositionMessage(
            a.kind,
            a.path,
            applied ? "auto-applied" : "failed",
            applied ? undefined : "the edit could not be applied to the document",
          ),
          isReadOnly: false,
          isError: !applied,
        });
      }
      if (autoApplied.length > 0) this.renderEditPanel();

      return parked;
    });

    await Promise.all(
      toPark.map(async (p) => {
        const pending = this.pending.get(p.hunkId);
        if (!pending) {
          results.set(p.callId, editCancelled(p.kind, p.path));
          return;
        }
        const { disposition, reason } = await pending.promise;
        results.set(p.callId, {
          content: editDispositionMessage(p.kind, p.path, disposition, reason),
          isReadOnly: false,
          isError: disposition === "failed",
        });
      }),
    );

    return calls.map((tc) => ({
      tc,
      result:
        results.get(tc.id) ??
        editCancelled(
          tc.name === "update_frontmatter" ? "frontmatter" : "edit",
          this.editTargetPath ?? "",
        ),
    }));
  }

  getProposal(): VaultOperationProposal | null {
    return this.proposal.ops.length > 0 ? this.proposal : null;
  }

  getAppliedRecord(): AppliedVaultOpRecord | null {
    return this.appliedRecord;
  }

  getEditProposal(): EditProposal | null {
    return this.editProposal && this.editProposal.hunks.length > 0 ? this.editProposal : null;
  }

  getEditAppliedRecord(): AppliedEditRecord | null {
    return this.editAppliedRecord;
  }

  /**
   * Tear down the in-loop edit panel before finalization re-renders the durable
   * one in the message body. The proposal/record live on; only the transient
   * loop-time DOM is removed so it can't double up with the finalized panel.
   */
  detachEditPanel(): void {
    this.editPanel?.destroy();
    this.editPanel = null;
    this.editDeps?.host.remove();
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

  // --- Edit channel helpers ----------------------------------------------

  /**
   * The turn's single {@link EditReviewController} — the apply owner. Created on the
   * first resolved hunk so a turn with only no-matches mounts nothing. The panel
   * re-renders over it each round; statuses persist on the proposal's hunks.
   */
  private ensureEditController(targetPath: string, docText: string): EditReviewController {
    if (this.editController) return this.editController;
    this.editTargetPath = targetPath;
    this.editProposal = {
      id: generateId(),
      targetFilePath: targetPath,
      documentSnapshot: docText,
      snapshotTimestamp: Date.now(),
      hunks: [],
      prose: "",
    };
    this.editController = new EditReviewController(this.app, this.editProposal, {
      onHunksChanged: () => {
        /* statuses mutate in place; persistence happens at finalization. */
      },
      onApplied: (record) => {
        this.editAppliedRecord = record;
      },
      onUndone: () => {
        this.editAppliedRecord = null;
      },
    });
    this.editController.subscribe((change) => this.handleEditResolved(change.hunkId, change.status));
    return this.editController;
  }

  /** Populate a structural block (frontmatter) against its target file; pass others through. */
  private async resolveStructural(block: EditBlock, filePath: string): Promise<EditBlock> {
    if (!block.toolName) return block;
    const [resolved] = await resolveStructuralEditBlocks([block], { app: this.app, filePath });
    return resolved ?? block;
  }

  /** Re-render the live diff panel over the kept controller and refresh the overlay. */
  private renderEditPanel(): void {
    const deps = this.editDeps;
    if (!deps || !this.editController) return;
    this.editPanel?.destroy();
    deps.host.empty();
    this.editPanel = new DiffReviewPanel(deps.host, this.app, deps.owner, this.editController, {
      live: true,
    });
    deps.inlineDiff.attach(this.editController);
  }

  /** A hunk reached a terminal status in either renderer — resolve its parked promise. */
  private handleEditResolved(hunkId: string, status: EditStatus): void {
    const parked = this.pending.get(hunkId);
    if (!parked) return;
    if (status === "accepted") {
      this.pending.delete(hunkId);
      parked.resolve({ disposition: "applied" });
    } else if (status === "rejected") {
      this.pending.delete(hunkId);
      parked.resolve({ disposition: "declined" });
    }
    // "pending" (a mid-loop undo) leaves the op parked — rare and intentionally ignored.
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

/** An invalid / denied edit call — surfaced as the call's error tool result. */
function editError(call: ToolCall, reason: string): ToolResult {
  return { content: `${call.name} could not run: ${reason}.`, isReadOnly: false, isError: true };
}

/** A parked edit cancelled before the user decided (abort / new turn). */
function editCancelled(kind: EditOpKind, path: string): ToolResult {
  return { content: editDispositionMessage(kind, path, "cancelled"), isReadOnly: false };
}

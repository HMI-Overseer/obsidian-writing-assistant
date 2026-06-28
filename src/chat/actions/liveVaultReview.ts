import { type App, normalizePath } from "obsidian";
import type { ErrorKind, ToolCall, ToolResult, VaultOpReviewer } from "../../tools/types";
import type {
  AppliedVaultOpRecord,
  ReviewableVaultOp,
  VaultOperation,
  VaultOperationProposal,
} from "../../vault-ops/types";
import { diskState, diskFingerprint } from "../../vault-ops/apply";
import { applyVaultOpBatch } from "../../vault-ops/applyBatch";
import { resolveEditGate, targetPaths, type VaultOpPolicy } from "../../vault-ops/gateway";
import type { ApprovalPosture } from "../../shared/types";
import { escapesVault, outsideVaultMessage } from "../../vault-ops/pathSafety";
import {
  preReadTrashSnapshots,
  preScanReplacements,
  gateConvertedOp,
  buildReviewableOp,
} from "../../vault-ops/proposalSupport";
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
  MatchType,
} from "../../editing/editTypes";
import { resolveEdits } from "../../editing/diffEngine";
import { EditReviewController } from "../../editing/EditReviewController";
import type { InlineDiffManager } from "../../editing/inlineDiff/InlineDiffManager";
import { EditReviewTimelineView } from "../messages/editReviewTimeline";
import { convertToolCallToEditBlock } from "../../tools/editing/conversion";
import { resolveStructuralEditBlocks } from "../../tools/editing/handlers";
import { defaultRecovery, trimDot } from "../../tools/toolFailure";
import { generateId } from "../../utils";

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
 * Dependencies for the edit channel, present only in edit mode. Edits are vault
 * ops too; their apply path is the {@link EditReviewController} and their review now
 * folds into the agentic timeline via {@link EditReviewTimelineView} (like vault ops),
 * with the in-note overlay as a second view over the same controller, so the
 * coordinator needs only the overlay manager and the resolver tuning.
 */
export interface LiveEditReviewDeps {
  /** The shared overlay manager, the second renderer over the same controller. */
  inlineDiff: InlineDiffManager;
  /** Resolver tuning from settings (context lines, min confidence). */
  resolveOptions: { contextLines: number; minConfidence: number };
  /** Flip the session to auto-apply; powers the timeline's "Accept all this session". */
  onEnterAutoApply?: () => void;
}

export interface LiveVaultReviewOptions {
  app: App;
  /** The streaming bubble's timeline element, where the review decorates steps. */
  timelineEl: HTMLElement;
  policy: VaultOpPolicy;
  /** Session approval posture; `auto` overrules the per-class policy to auto-apply (§6.3). */
  posture: ApprovalPosture;
  /** Edit-channel dependencies. Absent when no writes are permitted (read-only). */
  edit?: LiveEditReviewDeps;
}

/**
 * In-loop vault-op review coordinator (in-loop-tool-approval-blocking-flow).
 *
 * Owns one growing {@link VaultOperationProposal}, mounts {@link VaultReviewTimelineView}
 * live on the streaming bubble, applies `auto` ops immediately, and, for `ask`
 * ops, hands the tool loop a promise that resolves only when the user approves or
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
export class LiveVaultReview implements VaultOpReviewer {
  private readonly app: App;
  private readonly timelineEl: HTMLElement;
  private readonly policy: VaultOpPolicy;
  private readonly posture: ApprovalPosture;

  private readonly proposal: VaultOperationProposal;
  private appliedRecord: AppliedVaultOpRecord | null = null;
  /** All vault-op calls seen so far, the intent overlay later rounds resolve against. */
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
  /** One controller for the whole turn, the single apply owner; the view re-renders over it. */
  private editController: EditReviewController | null = null;
  /** The live timeline review, re-rendered (destroy + recreate) per round over {@link editController}. */
  private editTimelineView: EditReviewTimelineView | null = null;
  private editAppliedRecord: AppliedEditRecord | null = null;
  /** The one note this turn edits, fixed by the first resolved edit (one file per turn). */
  private editTargetPath: string | null = null;

  constructor(opts: LiveVaultReviewOptions) {
    this.app = opts.app;
    this.timelineEl = opts.timelineEl;
    this.policy = opts.policy;
    this.posture = opts.posture;
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

    // Resolve `ask` ops **serially**, in proposal order
    // (ask-ops-resolve-as-batch-not-sequential): the user decides one before the
    // next is offered (the timeline mounts `serial`), and a decline propagates to
    // dependent ops via {@link handleResolved} → {@link propagateDeclines}, failing
    // them with a reason naming the declined prerequisite. Parked references are
    // captured up front so an op failed by propagation (which clears it from
    // `pending`) is still collected here.
    const parkedEntries = askEntries.map((e) => ({ e, parked: this.pending.get(e.reviewable.id) }));
    for (const { e, parked } of parkedEntries) {
      if (!parked) continue;
      const { disposition, reason } = await parked.promise;
      results.set(e.call.id, dispoResult(e.reviewable.op, disposition, reason));
    }

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
   * when `ask`, returning the *real* disposition as that call's tool result. A
   * no-match is reported honestly as `failed`, never a silent drop.
   */
  async resolveEdits(calls: ToolCall[]): Promise<Array<{ tc: ToolCall; result: ToolResult }>> {
    if (calls.length === 0) return [];
    const deps = this.editDeps;
    if (!deps) {
      return calls.map((tc) => ({
        tc,
        result: editError(
          tc,
          "edit review context unavailable",
          "unavailable",
          "retry the edit in a new message",
        ),
      }));
    }

    const results = new Map<string, ToolResult>();
    type Parked = {
      callId: string;
      hunkId: string;
      kind: EditOpKind;
      path: string;
      matchType: MatchType;
      /** > 1 when the search was non-unique; surfaced to the model on apply (symptom C). */
      occurrenceCount?: number;
    };

    // Registration + auto-apply run under the shared lock so the per-turn auto
    // budget and the controller stay consistent with the file-op channel; parking
    // on `ask` edits happens outside so a held edit never blocks the next round.
    const toPark = await this.runExclusive(async () => {
      const docCache = new Map<string, string>();
      const autoApplied: Parked[] = [];
      const parked: Parked[] = [];

      for (const call of calls) {
        const kind = editKind(call.name);
        const block = convertToolCallToEditBlock(call);
        if (!block) {
          results.set(call.id, editError(call, "could not parse edit arguments"));
          continue;
        }

        // A propose_edit with empty search text would otherwise resolve as a bogus
        // exact match (indexOf("") === 0) and silently insert at the top of the file.
        // Frontmatter blocks legitimately carry empty search (insert-at-top), so guard
        // only the prose edit channel, mirroring the legacy executeProposeEdit check.
        if (kind === "edit" && block.searchText === "") {
          results.set(
            call.id,
            editError(call, "search text is empty", "invalid-args", "pass the exact text you want to replace"),
          );
          continue;
        }

        // The model names its target via the required `path` arg (no active-doc
        // fallback), so an edit lands on the file it read, not whatever pane is open.
        if (!block.targetPath) {
          results.set(
            call.id,
            editError(
              call,
              "missing required 'path'",
              "invalid-args",
              "pass the vault-relative path of the note to edit",
            ),
          );
          continue;
        }
        const file = this.app.vault.getFileByPath(normalizePath(block.targetPath));
        if (!file) {
          results.set(
            call.id,
            editError(
              call,
              `file not found at "${block.targetPath}"`,
              "not-found",
              "check the path, or use write_file to create it",
            ),
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
              `this turn already edits "${this.editTargetPath}"`,
              "precondition",
              `edit "${file.path}" in a separate message`,
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
        if (!resolved || resolved.matchType === "none") {
          // Honest no-match, the model self-corrects on this result. `nearMiss` steers
          // the recovery: a close-but-rejected window is a wording difference (spacing
          // is already handled by the whitespace tier upstream), so nudge "re-read and
          // copy exactly"; otherwise the text is simply absent, so nudge "re-read".
          const recovery = resolved?.nearMiss
            ? "the closest text was close but not identical, re-read that passage and copy the exact wording, then retry"
            : "no location matched the search text; re-read the file and retry";
          results.set(call.id, {
            content: editDispositionMessage(kind, file.path, "failed", recovery, "none"),
            isReadOnly: false,
            isError: true,
            failure: { kind: "no-match", recovery },
          });
          continue;
        }

        const gate = resolveEditGate(this.policy, file.path, this.autoSoFar, this.posture);
        if (gate === "deny") {
          results.set(call.id, editError(call, "edits are denied by the current policy", "denied"));
          continue;
        }

        // A non-unique anchor on the autonomous path is refused, not silently applied to
        // one of several identical passages. Mirrors Anthropic's text-editor contract (a
        // str_replace matching more than one location returns an error asking for more
        // context) and the no-match recovery just above. Gated on `auto`: an ask-gated edit
        // stays reviewable (the human is the disambiguator, and the diff card shows the
        // "1 of N" badge), so only the no-human path blocks. The count is the symptom-C
        // signal resolveEdits already computes (diff-engine-real-document-robustness).
        if (gate === "auto" && resolved.occurrenceCount !== undefined) {
          const recovery =
            `the search text matched ${resolved.occurrenceCount} places; include the surrounding ` +
            "lines so it identifies exactly one passage, then retry";
          results.set(call.id, {
            content: editDispositionMessage(kind, file.path, "failed", recovery),
            isReadOnly: false,
            isError: true,
            failure: { kind: "ambiguous", recovery },
          });
          continue;
        }

        const controller = this.ensureEditController(file.path, docText);
        const hunk: DiffHunk = { id: generateId(), resolvedEdit: resolved, status: "pending" };
        controller.proposal.hunks.push(hunk);

        const matchType = resolved.matchType;
        const occurrenceCount = resolved.occurrenceCount;
        if (gate === "auto") {
          this.autoSoFar++;
          autoApplied.push({ callId: call.id, hunkId: hunk.id, kind, path: file.path, matchType, occurrenceCount });
        } else {
          this.park(hunk.id);
          parked.push({ callId: call.id, hunkId: hunk.id, kind, path: file.path, matchType, occurrenceCount });
        }
      }

      if (this.editController) this.renderEditPanel();

      for (const a of autoApplied) {
        await this.editController?.accept(a.hunkId);
        const applied = this.editController?.getStatus(a.hunkId) === "accepted";
        const reason = applied ? undefined : "the edit could not be applied to the document";
        results.set(a.callId, {
          content: editDispositionMessage(
            a.kind,
            a.path,
            applied ? "auto-applied" : "failed",
            reason,
            a.matchType,
            a.occurrenceCount,
          ),
          isReadOnly: false,
          isError: !applied,
          failure: applied ? undefined : { kind: "failed", recovery: reason },
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
          content: editDispositionMessage(p.kind, p.path, disposition, reason, p.matchType, p.occurrenceCount),
          isReadOnly: false,
          isError: disposition === "failed",
          failure: disposition === "failed" ? { kind: "failed", recovery: reason } : undefined,
        });
      }),
    );

    return calls.map((tc) => ({
      tc,
      result: results.get(tc.id) ?? editCancelled(editKind(tc.name), this.editTargetPath ?? ""),
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
   * Drop the in-loop edit timeline view's controller subscription before
   * finalization mounts the durable one. The proposal/record live on; finalization's
   * fresh view cleans the loop-time step decorations, so nothing doubles up.
   */
  detachEditPanel(): void {
    this.editTimelineView?.destroy();
    this.editTimelineView = null;
  }

  /**
   * Resolve every outstanding `ask` op as `cancelled` (abort / new user turn), so a
   * parked turn can't leak a hung await. Ops are left `pending` so the user can still
   * decide later via the finalized review surface, graceful fallback to async review.
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

    // A trashed file's snapshot is what its inverse recreates on undo; pre-read so
    // conversion stays synchronous (shared with the finalize path). A replace's
    // per-file targets are scanned the same way.
    const snapshots = await preReadTrashSnapshots(this.app, calls);
    const replaceScans = await preScanReplacements(this.app, calls);

    const probes: ConversionProbes = {
      resolve,
      fingerprint: (p) => diskFingerprint(this.app, p),
      readContent: (p) => snapshots.get(normalizePath(p)) ?? null,
      configDir: this.app.vault.configDir,
      replaceTargets: (callId) => replaceScans.get(callId) ?? null,
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
          result: {
            // The validator message is already a self-correcting sentence (e.g. the
            // out-of-vault reason ends with "Use a vault-relative path"), so don't
            // stack a second generic recovery on top, that only made it heavier.
            content: `Error: invalid ${call.name} arguments, ${trimDot(error)}.`,
            isReadOnly: false,
            isError: true,
            failure: { kind: "invalid-args", recovery: defaultRecovery("invalid-args") },
          },
        });
        continue;
      }

      const { op, satisfied: isSatisfied } = found;
      const { gate, autoConsumed } = gateConvertedOp(op, isSatisfied, this.policy, this.autoSoFar, this.posture);
      if (gate === "deny") {
        // Denied tools are filtered upstream (Phase 4); guard anyway.
        const recovery = defaultRecovery("denied");
        entries.push({
          call,
          kind: "error",
          result: {
            content: `Error: ${call.name} is not permitted by the current policy. ${trimDot(recovery)}.`,
            isReadOnly: false,
            isError: true,
            failure: { kind: "denied", recovery },
          },
        });
        continue;
      }
      if (autoConsumed) this.autoSoFar++;

      const reviewable = buildReviewableOp(this.app, op, gate, isSatisfied, call.id);
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
    // SECURITY INVARIANT (first-class, defense in depth), auto-apply must NEVER
    // write outside the vault. An escaping path is already refused at conversion
    // (layer 1), pre-flight (layer 2), and the disk executor (layer 3); the
    // auto-apply orchestrator re-checks the boundary here in its own right, so a
    // future refactor of the conversion stage cannot open an auto-apply hole. A
    // single escaping op fails the *whole* auto batch, nothing reaches
    // applyVaultOpBatch or disk, the conservative all-or-nothing stance for a
    // safety violation. See docs/work/issues/RESOLVED-vault-path-boundary-out-of-vault-escape.md §6.2.
    if (this.refuseEscapingAuto(autoEntries, results)) return;

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

  /**
   * The auto-apply layer's own vault-boundary defense (see {@link applyAuto}).
   * If any auto op's path escapes the vault, fail the *entire* batch in place,
   * marking every op `failed` with an accurate, model-facing reason and returning
   * `true` so the caller short-circuits before {@link applyVaultOpBatch} (and thus
   * disk) is ever reached. The escaping op names its own out-of-vault path; the
   * rest name the sibling that aborted the batch, so each op reports why it failed.
   * Returns `false` (no escape) for the normal path.
   */
  private refuseEscapingAuto(
    autoEntries: Array<Extract<Entry, { kind: "auto" }>>,
    results: Map<string, ToolResult>,
  ): boolean {
    const offending = autoEntries.flatMap((e) => targetPaths(e.reviewable.op)).find(escapesVault);
    if (offending === undefined) return false;

    for (const e of autoEntries) {
      e.reviewable.status = "failed";
      const own = targetPaths(e.reviewable.op).find(escapesVault);
      const reason =
        own !== undefined
          ? outsideVaultMessage(own)
          : `auto-apply aborted: "${offending}" is outside the vault, so nothing in this batch was applied`;
      results.set(e.call.id, dispoResult(e.reviewable.op, "failed", reason));
    }
    return true;
  }

  /** Create the parked promise for an `ask` op, keyed by op id. */
  private park(opId: string): void {
    let resolve!: PendingResolution["resolve"];
    const promise = new Promise<{ disposition: VaultOpDisposition; reason?: string }>((r) => {
      resolve = r;
    });
    this.pending.set(opId, { resolve, promise });
  }

  /** The timeline reported a terminal user decision, resolve the parked promise. */
  private handleResolved(opId: string, disposition: "applied" | "declined"): void {
    const parked = this.pending.get(opId);
    if (!parked) return;
    this.pending.delete(opId);
    parked.resolve({ disposition });
    // A declined folder (or one already stranded) leaves nowhere for the ops that
    // were going to write inside it, fail those before they can be approved.
    if (disposition === "declined") this.propagateDeclines();
  }

  /**
   * Strand the dependents of a declined/failed `create_directory`
   * (ask-ops-resolve-as-batch-not-sequential). Any still-awaiting `ask` op whose
   * destination would live inside a folder that will not be created this turn is
   * failed in place, with a reason naming the missing prerequisite, so the model
   * reads an honest `failed` (not a silent landing elsewhere) and can self-correct.
   *
   * Forward, transitive pass: a failed nested `create_directory` is itself added to
   * the missing set, so a declined `A/` also strands `A/B/` and anything under it.
   * Only fires under serial resolution, where the prerequisite is always decided
   * before its dependents are offered, so this never overrides a user approval.
   */
  private propagateDeclines(): void {
    const missingDirs = new Set(
      this.proposal.ops
        .filter(
          (o) => o.op.kind === "createDir" && (o.status === "rejected" || o.status === "failed"),
        )
        .map((o) => normalizePath((o.op as Extract<VaultOperation, { kind: "createDir" }>).path)),
    );
    if (missingDirs.size === 0) return;

    let changed = false;
    for (const o of this.proposal.ops) {
      if (o.gate !== "ask" || (o.status !== "pending" && o.status !== "accepted")) continue;
      if (o.op.kind === "trash") continue;
      const dest = destinationPath(o.op);
      const blocker = [...missingDirs].find((dir) => isWithinDir(dest, dir));
      if (!blocker) continue;

      const reason = `the folder "${blocker}" was declined, so there is nowhere to put "${dest}"`;
      o.status = "failed";
      const parked = this.pending.get(o.id);
      this.pending.delete(o.id);
      parked?.resolve({ disposition: "failed", reason });
      if (o.op.kind === "createDir") missingDirs.add(normalizePath(o.op.path));
      changed = true;
    }
    if (changed) this.remount();
  }

  // --- Edit channel helpers ----------------------------------------------

  /**
   * The turn's single {@link EditReviewController}, the apply owner. Created on the
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

  /** Re-render the live edit review on the timeline over the kept controller and refresh the overlay. */
  private renderEditPanel(): void {
    const deps = this.editDeps;
    if (!deps || !this.editController) return;
    this.editTimelineView?.destroy();
    this.editTimelineView = new EditReviewTimelineView({
      timelineEl: this.timelineEl,
      app: this.app,
      controller: this.editController,
      live: true,
      ...(deps.onEnterAutoApply && { onEnterAutoApply: deps.onEnterAutoApply }),
    });
    deps.inlineDiff.attach(this.editController);
  }

  /** A hunk reached a terminal status in either renderer, resolve its parked promise. */
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
    // "pending" (a mid-loop undo) leaves the op parked, rare and intentionally ignored.
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
      // Live mount serializes ask approval: one op offered at a time, so an early
      // decline strands its dependents before they're approved (the next round's
      // proposal then sees the real disposition).
      serial: true,
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
    failure: disposition === "failed" ? { kind: "failed", recovery: reason } : undefined,
  };
}

/** A call with no result is a parked op cancelled before it decided. */
function cancelledFallback(call: ToolCall): ToolResult {
  return { content: `${call.name} review was interrupted; still pending.`, isReadOnly: false };
}

/**
 * An invalid / denied edit call, surfaced as the call's error tool result. `what`
 * names the failure; `recovery` is the situated next step, defaulting per kind (via
 * the shared {@link defaultRecovery}) so every edit error carries one even when the
 * caller passes none. "Error:" prefix + uniform punctuation match the read channel.
 */
function editError(
  call: ToolCall,
  what: string,
  kind: ErrorKind = "invalid-args",
  recovery?: string,
): ToolResult {
  const step = recovery ?? defaultRecovery(kind);
  return {
    content: `Error: ${call.name} could not run: ${trimDot(what)}. ${trimDot(step)}.`,
    isReadOnly: false,
    isError: true,
    failure: { kind, recovery: step },
  };
}

/** A parked edit cancelled before the user decided (abort / new turn). */
function editCancelled(kind: EditOpKind, path: string): ToolResult {
  return { content: editDispositionMessage(kind, path, "cancelled"), isReadOnly: false };
}

/** Map an edit tool name to the disposition kind that shapes its model-facing wording. */
function editKind(toolName: string): EditOpKind {
  if (toolName === "update_frontmatter") return "frontmatter";
  if (toolName === "insert_into_note") return "insert";
  return "edit";
}

/**
 * The vault path an op writes to, the location that must live under an existing
 * folder for the op to make sense. `trash` has no created destination, so it never
 * depends on a freshly-created folder (callers exclude it before asking).
 */
function destinationPath(op: VaultOperation): string {
  switch (op.kind) {
    case "create":
    case "overwrite":
    case "createDir":
      return op.path;
    case "move":
    case "moveFolder":
      return op.to;
    case "trash":
    case "trashFolder":
      return op.path;
    case "replaceInVault":
      // A replace's targets already exist on disk, so it never depends on a folder
      // created this turn; "" is under no directory, so decline-propagation skips it.
      return "";
  }
}

/** True when `path` lies strictly inside directory `dir` (a child, not the dir itself). */
function isWithinDir(path: string, dir: string): boolean {
  const p = normalizePath(path);
  const d = normalizePath(dir);
  return p !== d && p.startsWith(`${d}/`);
}

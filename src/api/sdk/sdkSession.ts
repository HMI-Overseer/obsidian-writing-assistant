import type {
  ClaudeCodeResumeCursor,
  ReasoningLevel,
  SessionRebuildReason,
} from "../../shared/types";
import type { AssistantStreamEvent } from "../usageTypes";
import { generateId } from "../../utils";
import type { FlagSettableEffort } from "../../shared/reasoning";
import { createAbortError } from "../httpTransport";
import { closeIterator } from "../assistantStreamRun";
import { extractClaudeCodeContextTokens, type ClaudeCodeResultUsage } from "../claudeCodeProcess";
import {
  canFlipEffortMidSession,
  decideRecovery,
  fingerprint,
  hashPrefix,
  type HarnessSession,
  type SessionConfig,
  type SessionRecovery,
  type SessionTurn,
} from "../harnessSession";
import { resultErrorMessage, resultUsage } from "./sdkQueryEngine";
import { ClaudeCodeSdkMessageTranslator } from "./claudeCodeSdkMessageTranslator";
import { AbortError, query } from "./claudeAgentSdk";
import type { ModelInfo, Options, Query, SDKMessage, SDKUserMessage } from "./claudeAgentSdk";
import { ClaudeCodeProcessOwner } from "./claudeCodeSpawn";

/**
 * The persistent Claude Code session and its recovery ladder (Model A′).
 *
 * One long-lived SDK `query()` per conversation, driven in streaming-input mode so
 * the `claude` process stays alive between turns, retains context in memory, and
 * caches incrementally (the win one-shot processes can't give,
 * `docs/02-architecture/components/providers/claude-code.md`). Session persistence to
 * disk is on (the SDK default; the earlier zero-footprint Model B forced it off), so
 * when the live process is gone (idle eviction, Obsidian restart, plugin reload) the
 * registry can `resume` the session from `~/.claude` before falling back to a
 * synthetic rebuild. The three-rung recovery ladder is:
 *
 *   live reuse (warm process) → disk resume (Model A′) → synthetic rebuild
 *
 * The plugin transcript stays authoritative throughout: a live session is reused,
 * and a disk session resumed, only when {@link decideRecovery} confirms the live
 * transcript cleanly extends what was banked (linearity + config gates, identical to
 * live reuse, our own hash never Claude Code's file). On any doubt (abort, SDK error,
 * unexpected end, config drift, a resume that can't start) it degrades one rung, and
 * a synthetic rebuild is always the floor. See ADR-0016.
 */

/** Idle sessions are disposed after this long unused (kills the `claude` process). */
const DEFAULT_IDLE_MS = 15 * 60 * 1000;
/** How often the registry sweeps for idle sessions. */
const SWEEP_INTERVAL_MS = 60 * 1000;

/** Wraps a turn's prompt as the streaming-input user message the SDK expects. */
function userMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  };
}

/**
 * Whether a streamed message is the SDK's compaction-boundary signal, the session
 * has summarized its context, so it no longer holds the transcript verbatim and must
 * be invalidated after the turn.
 */
function isCompactBoundary(message: SDKMessage): boolean {
  return message.type === "system" && message.subtype === "compact_boundary";
}

/**
 * A push-driven `AsyncIterable<SDKUserMessage>` feeding the SDK's streaming input.
 * The SDK pulls `next()` and we resolve it when a turn pushes a message, keeping
 * the underlying process alive and awaiting between turns.
 */
class SessionInputStream implements AsyncIterable<SDKUserMessage> {
  private readonly queued: SDKUserMessage[] = [];
  private pending: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) return;
    if (this.pending) {
      const resolve = this.pending;
      this.pending = null;
      resolve({ value: message, done: false });
    } else {
      this.queued.push(message);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pending) {
      const resolve = this.pending;
      this.pending = null;
      resolve({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () =>
        new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          const queued = this.queued.shift();
          if (queued) {
            resolve({ value: queued, done: false });
          } else if (this.closed) {
            resolve({ value: undefined as never, done: true });
          } else {
            this.pending = resolve;
          }
        }),
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

/** Per-turn context the session needs to stream a reply and update its watermark. */
interface SessionTurnContext {
  /** Full live transcript including the new user turn being sent. */
  turns: readonly SessionTurn[];
  signal?: AbortSignal;
  onResult?: (usage: ClaudeCodeResultUsage) => void;
}

export class SdkSession {
  readonly meta: HarnessSession;
  /** Epoch ms of the last turn, drives idle eviction. */
  lastUsedAt: number;
  /**
   * Effort the live session currently runs at: the mint-time `Options.effort`
   * (null = nothing sent, model default), then whatever the last
   * {@link setEffort} flip applied. Deliberately outside the config fingerprint,
   * the registry compares it per turn and flips or rebuilds (section 3.2).
   */
  effort: ReasoningLevel | null;

  private readonly input = new SessionInputStream();
  private readonly query: Query;
  private readonly iterator: AsyncIterator<SDKMessage>;
  private readonly abortController = new AbortController();
  /**
   * Owns the CLI child the SDK spawns for this session, so disposal has a bounded
   * hard tier ({@link ./claudeCodeSpawn.ClaudeCodeProcessOwner}, maintainer
   * decision 15.2).
   */
  private readonly processOwner = new ClaudeCodeProcessOwner();
  private disposed = false;
  private disposal: Promise<void> | null = null;
  private busy = false;
  /** Set when the last turn ended on a clean `interrupt()`, the session survives. */
  private interruptedCleanly = false;
  /** Set when the session compacted its context mid-turn, it must be rebuilt next turn. */
  private compacted = false;
  /**
   * The CLI session id observed on the last `result`, the id the persistent-session
   * disk `resume` (Model A′) targets. On a resumed session it is the same id that was
   * resumed (the CLI does not rotate it, section 6.7.1). Undefined until the first result.
   */
  private sessionId: string | undefined;

  /**
   * @param buildOptions builds the SDK `Options` given the session's abort
   *   controller (and, on a disk resume, the session id to load); called once at
   *   construction so model / system prompt / MCP server are baked for the session's
   *   lifetime (config drift → new session). The third argument is the session's
   *   process owner, which the builder passes to the SDK as
   *   `spawnClaudeCodeProcess` so disposal has a bounded hard tier.
   * @param resumeSessionId when set, the session is `resume`d from that id on disk
   *   (Model A′) rather than minted fresh, so the caller sends only the delta turn.
   */
  constructor(
    buildOptions: (
      abortController: AbortController,
      resumeSessionId?: string,
      processOwner?: ClaudeCodeProcessOwner,
    ) => Options,
    meta: HarnessSession,
    effort: ReasoningLevel | null = null,
    resumeSessionId?: string,
  ) {
    this.meta = meta;
    this.effort = effort;
    this.lastUsedAt = Date.now();
    this.sessionId = resumeSessionId;
    this.query = query({
      prompt: this.input,
      options: buildOptions(this.abortController, resumeSessionId, this.processOwner),
    });
    this.iterator = this.query[Symbol.asyncIterator]();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * True while a turn is in flight, streaming, or parked waiting on a user
   * approval. The idle sweep ({@link SdkSessionRegistry.evictIdle}) skips busy
   * sessions: disposing one mid-turn kills the live `claude` process and surfaces
   * to the user as "Claude Code session ended unexpectedly".
   */
  get isBusy(): boolean {
    return this.busy;
  }

  /**
   * True when the last turn ended on a clean `interrupt()` (abort that preserved the
   * live process). The registry reads this to keep the session for reuse instead of
   * disposing it, any *other* error leaves the session tail indeterminate and
   * disposes (`docs/work/plans/claude-code-sdk-refactor-plan.md`).
   */
  get wasInterruptedCleanly(): boolean {
    return this.interruptedCleanly;
  }

  /**
   * True when the session compacted its context to a summary mid-turn. The plugin
   * transcript stays authoritative, so the registry invalidates the session after
   * the turn and the next turn cold-rebuilds (compaction → desync guard).
   */
  get needsInvalidation(): boolean {
    return this.compacted;
  }

  /**
   * The CLI session id this session runs under (from its last `result`), or
   * undefined before the first result. The registry banks it into the conversation's
   * resume cursor so a later turn, once the live process is gone, can `resume` it
   * from disk (Model A′).
   */
  get bankedSessionId(): string | undefined {
    return this.sessionId;
  }

  /**
   * Sends one turn into the live session and streams its reply as text deltas.
   * `prompt` is the full transcript on a cold mint or just the new user turn on
   * reuse, the registry decides which. On clean completion the session's
   * watermark (`coveredCount` + `prefixHash`) advances to cover the new user turn
   * plus the reply it just generated, so the next turn's reuse check is exact.
   */
  async *runTurnEvents(
    prompt: string,
    ctx: SessionTurnContext,
  ): AsyncGenerator<AssistantStreamEvent> {
    if (this.disposed) throw new Error("Claude Code session was disposed");
    // The chat UI serializes generation, but guard against a second turn racing
    // into one session's single message stream.
    if (this.busy) throw new Error("Claude Code session is already running a turn");
    this.busy = true;
    this.lastUsedAt = Date.now();
    this.interruptedCleanly = false;
    this.compacted = false;

    // Already cancelled before the turn opened, don't push a message we'd abandon.
    if (ctx.signal?.aborted) {
      this.busy = false;
      throw createAbortError();
    }

    // Abort preserves the session: `interrupt()` ends the current turn but keeps the
    // streaming-input query alive for reuse, unlike `abortController.abort()` which
    // kills the process. If the control request fails, fall back to a hard abort
    // (→ the registry disposes the session and the next turn is cold).
    let interruptRequested = false;
    const onAbort = () => {
      interruptRequested = true;
      void this.query.interrupt().catch(() => this.abortController.abort());
    };
    ctx.signal?.addEventListener("abort", onAbort, { once: true });

    const segmentPrefix = `claude-segment-${generateId()}`;
    const translator = new ClaudeCodeSdkMessageTranslator({
      createSegmentId: (index) => `${segmentPrefix}-${index}`,
      toolCorrelation: "provider_id",
    });
    let contextTokens: number | null = null;
    // A turn ends one of three ways, and only the third is a leak. `reachedTerminal`
    // marks the provider's own `result`, `threw` marks a failure propagating to the
    // caller, and neither being set means the consumer stopped reading while the
    // query was still producing (RFC-0011 criterion 18).
    let reachedTerminal = false;
    let threw = false;
    try {
      this.input.push(userMessage(prompt));
      // Manual iteration (not `for await`): a `for await` that `break`s on the
      // terminal `result` would call the Query's `return()` and kill the session.
      // We read until `result`, then pause the iterator, leaving the process alive.
      for (;;) {
        const next = await this.iterator.next();
        if (next.done) throw new Error("Claude Code session ended unexpectedly");
        const message = next.value;

        const translated = translator.translate(message);
        for (const event of translated) {
          if (interruptRequested && event.type === "turn_end") continue;
          yield event;
        }

        contextTokens = extractClaudeCodeContextTokens(message) ?? contextTokens;

        if (isCompactBoundary(message)) {
          // The session summarized its context mid-turn. Finish streaming the reply,
          // but flag for invalidation: the next turn must cold-rebuild from the
          // authoritative transcript (the session no longer holds it verbatim).
          this.compacted = true;
          continue;
        }

        if (message.type === "assistant" && message.error) {
          throw new Error(`Claude Code error: ${message.error}`);
        }

        if (message.type === "result") {
          if (interruptRequested) {
            // Clean interrupt: the turn ended on our request with the process intact.
            // Bank the partial reply as the covered assistant turn, it equals the
            // streamed deltas the chat layer persists on abort, so the next turn can
            // reuse the live session, then surface the abort to the chat layer.
            const usage = resultUsage(message, contextTokens);
            this.sessionId = usage.sessionId ?? this.sessionId;
            ctx.onResult?.(usage);
            this.advanceWatermark(ctx.turns, translator.rawText());
            this.interruptedCleanly = true;
            this.lastUsedAt = Date.now();
            reachedTerminal = true;
            throw createAbortError();
          }
          if (message.subtype !== "success" || message.is_error) {
            throw new Error(resultErrorMessage(message));
          }
          const usage = resultUsage(message, contextTokens);
          this.sessionId = usage.sessionId ?? this.sessionId;
          ctx.onResult?.(usage);
          this.advanceWatermark(ctx.turns, translator.rawText());
          this.lastUsedAt = Date.now();
          reachedTerminal = true;
          return;
        }
      }
    } catch (error) {
      threw = true;
      if (ctx.signal?.aborted || error instanceof AbortError) throw createAbortError();
      throw error;
    } finally {
      ctx.signal?.removeEventListener("abort", onAbort);
      this.busy = false;
      if (!reachedTerminal && !threw) {
        // The consumer walked away mid-turn. Clearing `busy` was all this used to
        // do, which left the query producing into nothing and its MCP callbacks
        // still routable. The session's tail is now indeterminate, so it cannot be
        // reused either: dispose it rather than hand a half-read turn to the next
        // one.
        await this.dispose();
      }
    }
  }

  /** Text-only compatibility projection for non-canonical session callers. */
  async *runTurn(
    prompt: string,
    ctx: SessionTurnContext,
  ): AsyncGenerator<string> {
    for await (const event of this.runTurnEvents(prompt, ctx)) {
      if (event.type === "prose_delta") yield event.delta;
    }
  }

  /**
   * Flips the live session's effort via the SDK's mid-session flag-settings
   * control request (E3-verified: honored next turn, overrides mint-time
   * `Options.effort`; the process, in-memory context, and transcript are all
   * retained). Costs one API prompt-cache re-write on the next turn, the same
   * cache cost a cold rebuild pays, minus the respawn and transcript resend.
   */
  async setEffort(level: FlagSettableEffort): Promise<void> {
    await this.query.applyFlagSettings({ effortLevel: level });
    this.effort = level;
  }

  /**
   * The handshake's model list (`supportedModels()` control request), the
   * section 3.1 layer-2 discovery source: each entry carries `supportedEffortLevels`
   * for the effort-level harvest.
   */
  supportedModels(): Promise<ModelInfo[]> {
    return this.query.supportedModels();
  }

  /**
   * Disposes the session and resolves once the CLI child is provably gone.
   *
   * Phase 0 measured that the old body, `input.close()` + `abort()` +
   * `iterator.return()`, returns in about two seconds and leaves the `claude`
   * process running, because the SDK's kill chain is 2000 ms then a further
   * 5000 ms and every one of its timers is `unref()`ed. Idle eviction and unload
   * both ran that body, so both could leak a live process whose MCP callbacks
   * still routed.
   *
   * Disposal is discard, not a graceful stop, so it goes straight to the hard
   * tier: a session being disposed is never reused, and the only graceful path
   * that matters, a user Stop that preserves the session, takes `interrupt()`
   * instead and never arrives here. Idempotent; concurrent callers await the same
   * disposal.
   */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.input.close();
    this.abortController.abort();
    // Issued synchronously, before any await: `hardDispose()` runs `kill()` inside
    // its promise executor, so the child dies even when the caller cannot await,
    // which is exactly the plugin-unload case. Returning the iterator afterwards is
    // then cleanup that no longer races the process.
    const killed = this.processOwner.hardDispose();
    this.disposal = (async () => {
      await closeIterator(this.iterator);
      try {
        await killed;
      } catch {
        // Exit could not be proven within the deadline. The kill was still issued;
        // swallowing here keeps disposal from becoming the failure a caller sees,
        // and the run's settlement is what records the unproven quiescence.
      }
    })();
    return this.disposal;
  }

  /**
   * Advances the watermark to cover the new user turn(s) just sent plus the reply
   * just generated. The covered prefix becomes the live transcript plus a synthetic
   * assistant turn carrying the streamed text, exactly what the next turn hashes.
   */
  private advanceWatermark(turns: readonly SessionTurn[], assistantText: string): void {
    const coveredCount = turns.length + 1;
    this.meta.coveredCount = coveredCount;
    this.meta.prefixHash = hashPrefix(
      [...turns, { role: "assistant", content: assistantText }],
      coveredCount,
    );
  }
}

/** Everything the registry needs to run (and possibly mint) a session for a turn. */
export interface SessionTurnRequest {
  /** Config the turn runs under, gates reuse and is baked into a fresh session. */
  cfg: SessionConfig;
  /**
   * Effort the turn should run at (null = model default, nothing sent). Not part
   * of {@link SessionConfig}: a `low..xhigh` change flips the live session via
   * {@link SdkSession.setEffort} instead of rebuilding; only non-flippable
   * changes (to/from `max`, back to default) take the rebuild path.
   */
  effort: ReasoningLevel | null;
  /** Full live transcript including the new user turn being sent. */
  turns: readonly SessionTurn[];
  /** Prompt sent on a cold mint, the full transcript. */
  fullPrompt: string;
  /** Prompt sent on reuse *and on a disk resume*, only the new user turn. */
  deltaPrompt: string;
  /**
   * Builds SDK options for a session (invoked on a cold mint or a disk resume). The
   * second argument is the session id to `resume` from disk (Model A′); absent on a
   * fresh mint.
   */
  buildOptions: (
    abortController: AbortController,
    resumeSessionId?: string,
    processOwner?: ClaudeCodeProcessOwner,
  ) => Options;
  /**
   * The persisted resume cursor for this conversation (Model A′), read from the last
   * banked turn. When no live session is held, the registry re-checks it against this
   * turn's transcript and, if it passes, `resume`s the session from disk instead of
   * rebuilding. Absent ⇒ resume is not attempted.
   */
  resumeCursor?: ClaudeCodeResumeCursor;
  signal?: AbortSignal;
  onResult?: (usage: ClaudeCodeResultUsage) => void;
  /**
   * Reports the recovery decision (reused / resumed / rebuilt) for this turn (Phase 0
   * cache instrumentation, extended for Model A′). Fires exactly once per turn, with
   * the *final* tier, so a resume that fails to start and drops to a rebuild reports
   * the rebuild, not the abandoned resume.
   */
  onRecoveryDecision?: (decision: SessionRecovery) => void;
  /**
   * Receives the resume cursor this turn's session banked (Model A′), so the chat
   * layer can persist it as the conversation's next resume point. Fires once per
   * turn that banks a watermark (a clean completion), never on error/abort.
   */
  onSessionBanked?: (cursor: ClaudeCodeResumeCursor) => void;
  /**
   * Receives the handshake's model list when a fresh session is minted (never
   * on reuse), the section 3.1 layer-2 effort-level harvest. Fired fire-and-forget:
   * the turn streams without waiting, and a failed control request is
   * swallowed (the descriptor fallback keeps covering).
   */
  onModelsDiscovered?: (models: ModelInfo[]) => void;
}

/**
 * Per-conversation registry of live SDK sessions and the recovery ladder over them.
 * One session per conversation; each turn reuses the held warm session when valid
 * (delta), else, when the live process is gone, tries a disk `resume` (delta), else
 * mints a fresh session from the full transcript. Idle sessions are swept on a timer;
 * {@link disposeAll} kills everything on unload.
 */
export class SdkSessionRegistry {
  private readonly sessions = new Map<string, SdkSession>();
  /**
   * Disposal tombstones: conversation id → why its last session went away. Idle
   * eviction and compaction *delete* the registry entry, so the next turn would
   * otherwise decide `no-session` and the badge would read a misleading "session
   * started". The tombstone lets {@link decideRecovery} attribute a rebuild to its
   * real cause instead (ADR-0016) when there is no resume cursor to
   * check. One-shot: cleared the moment a session is minted or resumed, so a
   * tombstone present always implies no live session.
   */
  private readonly tombstones = new Map<string, SessionRebuildReason>();
  private sweepTimer: number | null = null;

  constructor(private readonly idleMs: number = DEFAULT_IDLE_MS) {}

  /** Number of live sessions (introspection / tests). */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Runs one turn for `conversationId` down the recovery ladder: reuse the warm
   * session, else `resume` it from disk, else mint fresh. A resume that cannot even
   * start (its session file was deleted by CLI retention) is a non-event: it drops to
   * a synthetic rebuild *within the same turn* (section 6.3). Any failure disposes the
   * session so the next turn starts clean, the transcript can always rebuild.
   */
  async *runTurnEvents(
    conversationId: string,
    req: SessionTurnRequest,
  ): AsyncGenerator<AssistantStreamEvent> {
    const existing = this.sessions.get(conversationId);
    const effort = req.effort ?? null;
    let decision = decideRecovery(
      existing,
      req.turns,
      req.cfg,
      req.resumeCursor,
      this.tombstones.get(conversationId),
    );

    // Effort is compared outside the config fingerprint: a flippable change is
    // applied to the live session (one control request, context retained); a
    // non-flippable one (to/from `max`, back to default) or a failed control
    // request downgrades to the classic reasoning-changed cold rebuild. Only the
    // warm-reuse tier holds a live process to flip; a resume mints a fresh process
    // that bakes the requested effort at construction, so it needs no flip.
    if (decision.outcome === "reused" && existing && existing.effort !== effort) {
      if (canFlipEffortMidSession(existing.effort, effort)) {
        try {
          await existing.setEffort(effort as FlagSettableEffort);
        } catch {
          decision = { outcome: "rebuilt", reason: "reasoning-changed" };
        }
      } else {
        decision = { outcome: "rebuilt", reason: "reasoning-changed" };
      }
    }

    // Resume tier: restore from disk and stream the delta. A resume that fails to
    // produce a first chunk (session file gone) is caught here and rewritten to a
    // synthetic rebuild, so `onRecoveryDecision` still fires exactly once, with the
    // final tier. A resume that fails mid-stream, or is aborted, is a genuine failure
    // and propagates like any other turn error.
    if (decision.outcome === "resumed") {
      const resumed = this.mintSession(conversationId, req, effort, decision.cursor);
      const attempt = resumed.runTurnEvents(req.deltaPrompt, this.turnCtx(req));
      let first: IteratorResult<AssistantStreamEvent> | undefined;
      try {
        first = await attempt.next();
      } catch (error) {
        if (isAbortError(error)) {
          this.afterTurnError(conversationId, resumed);
          throw error;
        }
        // The resume never started: drop a rung to a synthetic rebuild in this turn.
        this.disposeSession(conversationId, resumed);
        decision = { outcome: "rebuilt", reason: this.tombstones.get(conversationId) ?? "session-disposed" };
      }
      if (decision.outcome === "resumed" && first) {
        req.onRecoveryDecision?.(decision);
        try {
          if (!first.done) {
            yield first.value;
            yield* attempt;
          }
          this.afterTurnSuccess(conversationId, resumed, req);
        } catch (error) {
          this.afterTurnError(conversationId, resumed);
          throw error;
        }
        return;
      }
      // Fell through: `existing` was undefined here (no live session on the resume
      // tier), so the mint/stream below starts clean with the rewritten decision.
    }

    req.onRecoveryDecision?.(decision);

    let session: SdkSession;
    let prompt: string;
    if (decision.outcome === "reused" && existing) {
      session = existing;
      prompt = req.deltaPrompt;
      this.ensureSweeping();
    } else {
      if (existing) void existing.dispose();
      session = this.mintSession(conversationId, req, effort);
      prompt = req.fullPrompt;
    }

    try {
      yield* session.runTurnEvents(prompt, this.turnCtx(req));
    } catch (error) {
      this.afterTurnError(conversationId, session);
      throw error;
    } finally {
      // A turn the consumer abandoned disposes itself (RFC-0011 criterion 18), so
      // the registry must not keep offering the corpse to the next turn.
      this.dropIfDisposed(conversationId, session);
    }
    this.afterTurnSuccess(conversationId, session, req);
  }

  /**
   * Hard-disposes whatever session a conversation currently holds and resolves once
   * its CLI child is provably gone. This is the persistent path's `hardDispose`
   * hook: it runs when the graceful tier overran its measured deadline, or when a
   * capture failure means the session's transcript is no longer authoritative and
   * it must not survive to be reused.
   */
  disposeConversation(conversationId: string): Promise<void> {
    const session = this.sessions.get(conversationId);
    if (!session) return Promise.resolve();
    this.sessions.delete(conversationId);
    this.tombstones.set(conversationId, "session-disposed");
    return session.dispose();
  }

  /** Drops a self-disposed session from the live map so no later turn reuses it. */
  private dropIfDisposed(conversationId: string, session: SdkSession): void {
    if (!session.isDisposed) return;
    if (this.sessions.get(conversationId) === session) {
      this.sessions.delete(conversationId);
      this.tombstones.set(conversationId, "session-disposed");
    }
  }

  /** Text-only compatibility projection for registry diagnostics and tests. */
  async *runTurn(
    conversationId: string,
    req: SessionTurnRequest,
  ): AsyncGenerator<string> {
    for await (const event of this.runTurnEvents(conversationId, req)) {
      if (event.type === "prose_delta") yield event.delta;
    }
  }

  /**
   * Mints (or resumes) a session, registers it as the conversation's live one, drops
   * the disposal tombstone (a session now owns the conversation), and fires the
   * mint-time model harvest. `resumeCursor` present ⇒ the session is `resume`d from
   * disk and its watermark is seeded from the cursor; absent ⇒ a fresh cold mint.
   */
  private mintSession(
    conversationId: string,
    req: SessionTurnRequest,
    effort: ReasoningLevel | null,
    resumeCursor?: ClaudeCodeResumeCursor,
  ): SdkSession {
    const meta = resumeCursor ? resumeMeta(req.cfg, resumeCursor) : mintMeta(req.cfg);
    const session = new SdkSession(req.buildOptions, meta, effort, resumeCursor?.sessionId);
    this.sessions.set(conversationId, session);
    this.tombstones.delete(conversationId);
    this.ensureSweeping();

    // Mint-time harvest (section 3.1 layer 2): ask the fresh process for its model list in
    // the background. Failures are ignored, discovery is an upgrade over the
    // descriptor fallback, never a turn dependency. A resume spawns a fresh process
    // too, so the harvest applies there as well.
    if (req.onModelsDiscovered) {
      const onModelsDiscovered = req.onModelsDiscovered;
      void session
        .supportedModels()
        .then((models) => onModelsDiscovered(models))
        .catch(() => {});
    }
    return session;
  }

  /** Per-turn context passed into {@link SdkSession.runTurn}. */
  private turnCtx(req: SessionTurnRequest): SessionTurnContext {
    return { turns: req.turns, signal: req.signal, onResult: req.onResult };
  }

  /**
   * Post-turn bookkeeping after a session's stream completed cleanly: a mid-turn
   * compaction desynced the session from the authoritative transcript, so invalidate
   * it; otherwise bank the resume cursor for next turn.
   */
  private afterTurnSuccess(
    conversationId: string,
    session: SdkSession,
    req: SessionTurnRequest,
  ): void {
    if (session.needsInvalidation) {
      this.disposeSession(conversationId, session, "compacted");
    } else {
      this.bankCursor(session, req);
    }
  }

  /**
   * Post-turn bookkeeping after a session's stream threw. A clean interrupt preserves
   * the live process (its context now covers the partial reply), so keep it for
   * reuse. The exception is a mid-turn compaction, which desynced it and must be
   * disposed on every exit path (the {@link afterTurnSuccess} check is unreachable
   * when the turn throws, section 6.7.1). Any other error (SDK failure, unexpected end, hard
   * abort) leaves the tail indeterminate, so dispose it and cold-rebuild next turn. No
   * cursor is banked on a surviving interrupt: aborted turns persist no usage, so it
   * would be dropped, and the live session covers the immediate next turn anyway.
   */
  private afterTurnError(conversationId: string, session: SdkSession): void {
    if (!session.wasInterruptedCleanly || session.needsInvalidation) {
      this.disposeSession(
        conversationId,
        session,
        session.needsInvalidation ? "compacted" : undefined,
      );
    }
  }

  /**
   * Banks the session's watermark into the conversation's resume cursor (Model A′),
   * so a later turn can `resume` it once the live process is gone. Needs the session
   * id, observed on the turn's `result`; without it (no result reached) nothing is
   * banked.
   */
  private bankCursor(session: SdkSession, req: SessionTurnRequest): void {
    if (!req.onSessionBanked) return;
    const sessionId = session.bankedSessionId;
    if (!sessionId) return;
    req.onSessionBanked({
      sessionId,
      coveredCount: session.meta.coveredCount,
      prefixHash: session.meta.prefixHash,
      configFingerprint: session.meta.configFingerprint,
    });
  }

  /**
   * Disposes a session and drops it from the registry (only if still the live one).
   * `reason` records a disposal tombstone so the next turn's rebuild is attributed to
   * its cause rather than the neutral `no-session` (compaction here; idle eviction in
   * {@link evictIdle}). A plain error passes no reason, matching today's silent drop.
   */
  private disposeSession(
    conversationId: string,
    session: SdkSession,
    reason?: SessionRebuildReason,
  ): void {
    void session.dispose();
    if (this.sessions.get(conversationId) === session) {
      this.sessions.delete(conversationId);
      if (reason) this.tombstones.set(conversationId, reason);
    }
  }

  /**
   * Disposes every live session and stops the sweep timer (call on plugin unload).
   * Each `dispose()` issues its kill synchronously, so the children die even though
   * Obsidian's `onunload` cannot await; the returned promise is exit proof for
   * callers that can.
   */
  disposeAll(): Promise<void> {
    const disposals = [...this.sessions.values()].map((session) => session.dispose());
    this.sessions.clear();
    this.tombstones.clear();
    this.stopSweeping();
    return Promise.all(disposals).then(() => undefined);
  }

  /**
   * Disposes sessions unused for longer than the idle window. A busy session, a turn
   * in flight (possibly parked on a user approval), is never evicted: disposing it
   * mid-turn kills the live process and surfaces as "Claude Code session ended
   * unexpectedly". Its idle clock starts ticking only once the turn completes.
   */
  evictIdle(now: number = Date.now()): void {
    for (const [id, session] of this.sessions) {
      if (!session.isBusy && now - session.lastUsedAt > this.idleMs) {
        void session.dispose();
        this.sessions.delete(id);
        // Tombstone the eviction. The persisted resume cursor usually restores the
        // session next turn ("session resumed", Model A′); the tombstone is the
        // fallback attribution when there is no cursor to resume (or it fails its
        // gate): "expired" rather than the neutral "session started" (section 6.2).
        this.tombstones.set(id, "session-disposed");
      }
    }
    if (this.sessions.size === 0) this.stopSweeping();
  }

  private ensureSweeping(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = window.setInterval(() => this.evictIdle(), SWEEP_INTERVAL_MS);
  }

  private stopSweeping(): void {
    if (this.sweepTimer) {
      window.clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }
}

/** Mints fresh session metadata before its first turn advances the watermark. */
function mintMeta(cfg: SessionConfig): HarnessSession {
  return {
    provider: "claudecode",
    model: cfg.model,
    coveredCount: 0,
    prefixHash: "",
    configFingerprint: fingerprint(cfg),
    config: cfg,
  };
}

/**
 * Seeds session metadata from a resume cursor (Model A′): the disk session already
 * covers `coveredCount` turns, so the watermark starts there and this turn's delta
 * extends it exactly as a live-reuse turn would. `decideRecovery` already verified
 * the cursor's fingerprint equals `fingerprint(cfg)`, so the config is aligned.
 */
function resumeMeta(cfg: SessionConfig, cursor: ClaudeCodeResumeCursor): HarnessSession {
  return {
    provider: "claudecode",
    model: cfg.model,
    coveredCount: cursor.coveredCount,
    prefixHash: cursor.prefixHash,
    configFingerprint: cursor.configFingerprint,
    config: cfg,
  };
}

/** Whether a thrown value is the abort signal (a cancelled turn), not a real error. */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

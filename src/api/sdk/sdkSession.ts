import { createAbortError } from "../httpTransport";
import { extractClaudeCodeContextTokens, type ClaudeCodeResultUsage } from "../claudeCodeProcess";
import {
  decideReuse,
  fingerprint,
  hashPrefix,
  type HarnessSession,
  type SessionConfig,
  type SessionReuseDiagnosis,
  type SessionTurn,
} from "../harnessSession";
import { resultErrorMessage, resultUsage, textDelta } from "./sdkQueryEngine";
import { AbortError, query } from "./claudeAgentSdk";
import type { Options, Query, SDKMessage, SDKUserMessage } from "./claudeAgentSdk";

/**
 * Model B, the persistent in-memory Claude Code session.
 *
 * One long-lived SDK `query()` per conversation, driven in streaming-input mode so
 * the `claude` process stays alive between turns, retains context in memory, and
 * caches incrementally (the win one-shot processes can't give,
 * `docs/reference/architecture/claude-code-provider.md`). The session lives only in
 * process memory (`persistSession: false`), never on disk, so it's zero-footprint
 * and a process restart simply loses it → the next turn cold-rebuilds.
 *
 * The plugin transcript stays authoritative; a session is a disposable cache reused
 * only when {@link isSessionUsable} confirms the live transcript cleanly extends what
 * the session consumed (the registry below makes that call). On any doubt (abort, SDK
 * error, unexpected end) it is disposed and the next turn is cold.
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

  private readonly input = new SessionInputStream();
  private readonly query: Query;
  private readonly iterator: AsyncIterator<SDKMessage>;
  private readonly abortController = new AbortController();
  private disposed = false;
  private busy = false;
  /** Set when the last turn ended on a clean `interrupt()`, the session survives. */
  private interruptedCleanly = false;
  /** Set when the session compacted its context mid-turn, it must be rebuilt next turn. */
  private compacted = false;

  /**
   * @param buildOptions builds the SDK `Options` given the session's abort
   *   controller; called once at construction so model / system prompt / MCP
   *   server are baked for the session's lifetime (config drift → new session).
   */
  constructor(buildOptions: (abortController: AbortController) => Options, meta: HarnessSession) {
    this.meta = meta;
    this.lastUsedAt = Date.now();
    this.query = query({ prompt: this.input, options: buildOptions(this.abortController) });
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
   * Sends one turn into the live session and streams its reply as text deltas.
   * `prompt` is the full transcript on a cold mint or just the new user turn on
   * reuse, the registry decides which. On clean completion the session's
   * watermark (`coveredCount` + `prefixHash`) advances to cover the new user turn
   * plus the reply it just generated, so the next turn's reuse check is exact.
   */
  async *runTurn(prompt: string, ctx: SessionTurnContext): AsyncGenerator<string> {
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

    let assistantText = "";
    let contextTokens: number | null = null;
    try {
      this.input.push(userMessage(prompt));
      // Manual iteration (not `for await`): a `for await` that `break`s on the
      // terminal `result` would call the Query's `return()` and kill the session.
      // We read until `result`, then pause the iterator, leaving the process alive.
      for (;;) {
        const next = await this.iterator.next();
        if (next.done) throw new Error("Claude Code session ended unexpectedly");
        const message = next.value;

        const text = textDelta(message);
        if (text) {
          assistantText += text;
          yield text;
          continue;
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
            ctx.onResult?.(resultUsage(message, contextTokens));
            this.advanceWatermark(ctx.turns, assistantText);
            this.interruptedCleanly = true;
            this.lastUsedAt = Date.now();
            throw createAbortError();
          }
          if (message.subtype !== "success" || message.is_error) {
            throw new Error(resultErrorMessage(message));
          }
          ctx.onResult?.(resultUsage(message, contextTokens));
          this.advanceWatermark(ctx.turns, assistantText);
          this.lastUsedAt = Date.now();
          return;
        }
      }
    } catch (error) {
      if (ctx.signal?.aborted || error instanceof AbortError) throw createAbortError();
      throw error;
    } finally {
      ctx.signal?.removeEventListener("abort", onAbort);
      this.busy = false;
    }
  }

  /**
   * Disposes the session: closes the input stream, signals abort, and returns the
   * Query generator (which terminates the SDK process). Idempotent.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.input.close();
    this.abortController.abort();
    void this.iterator.return?.(undefined);
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
  /** Full live transcript including the new user turn being sent. */
  turns: readonly SessionTurn[];
  /** Prompt sent on a cold mint, the full transcript. */
  fullPrompt: string;
  /** Prompt sent on reuse, only the new user turn (the session holds the rest). */
  deltaPrompt: string;
  /** Builds SDK options for a fresh session (invoked only on a cold mint). */
  buildOptions: (abortController: AbortController) => Options;
  signal?: AbortSignal;
  onResult?: (usage: ClaudeCodeResultUsage) => void;
  /**
   * Reports the reuse-vs-rebuild decision for this turn before it runs (Phase 0
   * cache instrumentation). Fires exactly once per turn.
   */
  onReuseDecision?: (decision: SessionReuseDiagnosis) => void;
}

/**
 * Per-conversation registry of live SDK sessions. One session per conversation;
 * each turn either reuses the held session (when {@link isSessionUsable}) and sends
 * a delta, or disposes it and mints a fresh one from the full transcript. Idle
 * sessions are swept on a timer; {@link disposeAll} kills everything on unload.
 */
export class SdkSessionRegistry {
  private readonly sessions = new Map<string, SdkSession>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly idleMs: number = DEFAULT_IDLE_MS) {}

  /** Number of live sessions (introspection / tests). */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Runs one turn for `conversationId`, reusing the held session when valid and
   * cold-rebuilding otherwise. Any failure disposes the session so the next turn
   * starts clean, the transcript can always rebuild.
   */
  async *runTurn(conversationId: string, req: SessionTurnRequest): AsyncGenerator<string> {
    const existing = this.sessions.get(conversationId);
    const decision = decideReuse(existing, req.turns, req.cfg);
    req.onReuseDecision?.(decision);
    const reuse = decision.reuse;

    let session: SdkSession;
    let prompt: string;
    if (reuse && existing) {
      session = existing;
      prompt = req.deltaPrompt;
    } else {
      existing?.dispose();
      session = new SdkSession(req.buildOptions, mintMeta(req.cfg));
      this.sessions.set(conversationId, session);
      prompt = req.fullPrompt;
    }

    this.ensureSweeping();

    try {
      yield* session.runTurn(prompt, {
        turns: req.turns,
        signal: req.signal,
        onResult: req.onResult,
      });
    } catch (error) {
      // A clean interrupt preserves the live process (its context now covers the
      // partial reply), keep it for reuse. Any other error (SDK failure, unexpected
      // end, hard abort) leaves the session tail indeterminate, so dispose it and let
      // the next turn cold-rebuild from the authoritative transcript.
      if (!session.wasInterruptedCleanly) {
        this.disposeSession(conversationId, session);
      }
      throw error;
    }

    // Mid-turn compaction replaced the session's context with a summary; the
    // transcript stays authoritative, so invalidate now and cold-rebuild next turn.
    if (session.needsInvalidation) {
      this.disposeSession(conversationId, session);
    }
  }

  /** Disposes a session and drops it from the registry (only if still the live one). */
  private disposeSession(conversationId: string, session: SdkSession): void {
    session.dispose();
    if (this.sessions.get(conversationId) === session) {
      this.sessions.delete(conversationId);
    }
  }

  /** Disposes every live session and stops the sweep timer (call on plugin unload). */
  disposeAll(): void {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
    this.stopSweeping();
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
        session.dispose();
        this.sessions.delete(id);
      }
    }
    if (this.sessions.size === 0) this.stopSweeping();
  }

  private ensureSweeping(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.evictIdle(), SWEEP_INTERVAL_MS);
    // Don't let the sweep timer hold the process open (no-op in the browser).
    (this.sweepTimer as { unref?: () => void }).unref?.();
  }

  private stopSweeping(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
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

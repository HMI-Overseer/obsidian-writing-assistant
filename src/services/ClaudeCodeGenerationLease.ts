import type {
  AgenticStep,
  ApprovalPosture,
  EffectBoundary,
  EffectBoundaryGuard,
  EffectIntentRequest,
  EffectRunOwnership,
  GenerationAuditRecorder,
  ToolResultImageRecord,
} from "../shared/types";
import { crossWithDurableIntent } from "../shared/generationAudit";
import { ASK_TOOL_NAMES } from "../tools/ask/definition";
import type { AskUserResponder } from "../tools/ask/types";
import { EDIT_TOOL_NAMES } from "../tools/editing/definition";
import { MEMORY_MUTATION_TOOL_NAMES } from "../tools/memory/definition";
import type { VaultOpReviewer } from "../tools/types";
import { VAULT_OPS_TOOL_NAMES } from "../tools/vault-ops/definition";
import type { ImageDelivery } from "../tools/vault/handlers";
import type { VaultOpDisposition } from "../vault-ops/disposition";

/**
 * Generation-scoped ownership of Claude Code's callback surface (ADR-0032).
 *
 * Claude Code runs its agent loop inside its own process, so its tool calls arrive
 * as MCP callbacks rather than through the plugin's tool loop. Before this module
 * those callbacks read mutable `ClaudeCodeService` fields at call time, which meant
 * a straggler from a finished run was answered by whatever the *current* run had
 * installed. The lease replaces that: one generation's review owner, ask responder,
 * allow-list, active-file context, lifecycle sink, and cancellation signal are fixed
 * at activation and never replaced, and a callback captures the whole set in one
 * synchronous step before its first `await` (ADR-0032).
 *
 * The lease is per **generation**, not per provider attempt. The
 * {@link ../chat/streaming/TurnRunOwner.AttemptLease} still owns attempt lifetime and
 * capture identity; those two lifetimes are genuinely different. Review hosts, the
 * ask coordinator, and the allow-list are installed once per generation and are the
 * same objects across a retry, so binding them per attempt would mean handing them
 * over between attempts, and no lease could exist at all at the moment they are
 * installed. The attempt ordinal therefore rides the lease as evidence
 * ({@link ClaudeCodeGenerationLease.attemptOrdinal}), never as identity.
 */

/**
 * Tool-lifecycle event emitted as Claude Code calls the plugin's MCP tools during
 * a run. Claude Code's agent loop is internal to the subprocess, so these events
 * are the only window into its tool activity, the chat UI uses them to drive the
 * same agentic timeline the API providers populate through their own tool loop.
 */
export type ClaudeCodeToolEvent =
  | { phase: "start"; toolName: string; toolCallId: string }
  | {
      phase: "end";
      toolName: string;
      args: Record<string, unknown>;
      isError: boolean;
      /**
       * The tool result text returned to Claude Code. Surfaced on the timeline step's
       * error block when `isError`, so a failed call (e.g. an edit's no-match) shows
       * what the model saw, Claude Code's loop is otherwise opaque to the UI. Also the
       * source from which the step's replay digest and bounded record are computed.
       */
      content: string;
      toolCallId: string;
      /**
       * The reviewed op's real disposition, when this call went through the live
       * review, so the step persists the outcome for the cold-rebuild replay digest
       * (a decline resolves `isError: false`; ADR-0016). Absent on read tools.
       */
      disposition?: VaultOpDisposition;
      /**
       * Metadata for the images this result returned, never their bytes (RFC-0021 D6,
       * P7). The picture itself leaves through the MCP bridge; this is the side that
       * reaches the timeline and the persisted step, so the step can show a thumbnail
       * it reloads from the vault by path.
       *
       * This is the source the record is set from on the Claude Code path. The SDK's
       * echo of the same tool result carries text only, so it sets nothing here and
       * the identity merge keeps this value.
       */
      images?: ToolResultImageRecord[];
      /** Structured terminal ask state for transcript persistence and reload. */
      askStatus?: AgenticStep["askStatus"];
    };

/** Where one generation's callback surface is in its life. */
export type ClaudeCodeLeaseState =
  | "active"
  | "stopping"
  | "quiescent"
  | "tombstoned";

/**
 * Why a callback was not admitted.
 *
 * Closed and bounded: a refused callback learns only that this surface is not
 * answering. It cannot inspect review, authorization, interaction, correlation, or
 * collection state belonging to another generation (ADR-0032).
 */
export type CallbackRefusal =
  | "no_active_generation"
  | "generation_stopping"
  | "generation_settled"
  | "generation_tombstoned";

/**
 * The four named effect boundaries, now provider-neutral (ADR-0033).
 *
 * Claude Code's callback path originally owned these boundaries. The plugin's own
 * tool loop crosses the same boundaries through the same review owner, so the type
 * moved to {@link ../shared/types.EffectBoundary} and this name is kept as its
 * alias for the Claude-side call sites.
 */
export type ClaudeCodeEffectBoundary = EffectBoundary;

/** The boundary a tool crosses, or null when the tool has none. */
export function effectBoundaryFor(
  toolName: string,
): ClaudeCodeEffectBoundary | null {
  if (ASK_TOOL_NAMES.has(toolName)) return "ask_interaction";
  if (EDIT_TOOL_NAMES.has(toolName)) return "edit_review";
  if (VAULT_OPS_TOOL_NAMES.has(toolName)) return "vault_op_review";
  if (MEMORY_MUTATION_TOOL_NAMES.has(toolName)) return "memory_review";
  return null;
}

/** Everything one generation fixes before any callback can enter. Never replaced. */
export interface ClaudeCodeGenerationContext {
  /** Stable identity of this generation's callback surface. */
  readonly leaseId: string;
  /** The conversation the generation belongs to, or null for a one-shot run. */
  readonly conversationId: string | null;
  readonly posture: ApprovalPosture;
  /** What this run permits, resolved once from the posture and the vault-op policy. */
  readonly allowedTools: ReadonlySet<string>;
  /** The active note captured when the generation started, never re-read live. */
  readonly activeFilePath: string;
  /** The best correlation this transport can offer. Runtime evidence only lowers it. */
  readonly correlationPosture: "provider_id" | "none";
  /**
   * Whether an image `read` can reach this run's model, fixed with the rest of the
   * scope before any callback enters (RFC-0021 P1). The vault handler reads it off
   * the context the callback surface builds.
   */
  readonly imageDelivery: ImageDelivery;
  readonly review: VaultOpReviewer | null;
  readonly askResponder: AskUserResponder | null;
  readonly askSignal: AbortSignal | null;
  readonly lifecycle: ((event: ClaudeCodeToolEvent) => void) | null;
  /** The generation's cancellation signal, checked before every effect boundary. */
  readonly signal: AbortSignal | null;
  /**
   * The conversation-scoped durable audit this generation writes its write-ahead
   * intents to (ADR-0033). Null when the caller has no conversation to
   * write to, in which case a boundary crosses on liveness alone.
   */
  readonly audit: GenerationAuditRecorder | null;
}

/** The owners a generation installs once, at activation. */
export type ClaudeCodeGenerationOwners = Pick<
  ClaudeCodeGenerationContext,
  "review" | "askResponder" | "askSignal" | "lifecycle" | "signal" | "audit"
>;

/** What the runtime knows before the generation's owners exist. */
export type ClaudeCodeRuntimeScope = Omit<
  ClaudeCodeGenerationContext,
  keyof ClaudeCodeGenerationOwners
>;

/** Proof that one callback was admitted under one lease. */
export interface CallbackToken {
  readonly lease: ClaudeCodeGenerationLease;
  /** The attempt in flight when this callback was admitted. Evidence, not identity. */
  readonly attemptOrdinal: number;
  /** Idempotent, and the `finally` of every admitted callback. */
  release(): void;
}

/** Whether an admission attempt produced a token. */
export function isCallbackToken(
  admission: CallbackToken | CallbackRefusal,
): admission is CallbackToken {
  return typeof admission !== "string";
}

export class ClaudeCodeGenerationLease implements EffectBoundaryGuard {
  readonly context: ClaudeCodeGenerationContext;

  private leaseState: ClaudeCodeLeaseState = "active";
  private inFlight = 0;
  private quiet: Promise<void> | null = null;
  private resolveQuiet: (() => void) | null = null;
  private observedCorrelation: "provider_id" | "none";
  private attempt = 0;
  private readonly crossed = new Set<ClaudeCodeEffectBoundary>();
  private consequentialSink: (() => void) | null = null;
  private askClaimed = false;

  constructor(context: ClaudeCodeGenerationContext) {
    this.context = context;
    this.observedCorrelation = context.correlationPosture;
  }

  get state(): ClaudeCodeLeaseState {
    return this.leaseState;
  }

  /**
   * How many admitted callbacks have not released yet.
   *
   * Introspection for settlement and for tests. It is deliberately never compared
   * against a ceiling: RFC-0010 forbids a guard whose
   * trigger is "you have done N things".
   */
  get inFlightCount(): number {
    return this.inFlight;
  }

  /** The correlation actually observed this generation, lowered but never raised. */
  get toolCorrelation(): "provider_id" | "none" {
    return this.observedCorrelation;
  }

  /** The provider attempt in flight, recorded as evidence for the durable audit (ADR-0033). */
  get attemptOrdinal(): number {
    return this.attempt;
  }

  /** The effect boundaries this generation actually crossed. */
  get crossedBoundaries(): ReadonlySet<ClaudeCodeEffectBoundary> {
    return this.crossed;
  }

  /** True once any callback crossed a named effect boundary under this lease. */
  get consequentialCallbackEntered(): boolean {
    return this.crossed.size > 0;
  }

  /** True while an `ask_user` callback holds the interaction barrier. */
  get askPending(): boolean {
    return this.askClaimed;
  }

  /**
   * Synchronous admission (ADR-0032). Checks the state and increments
   * the in-flight count in one step, before the caller's first `await`, so a lease
   * that begins stopping between the check and the work cannot be entered.
   */
  enterCallback(): CallbackToken | CallbackRefusal {
    if (this.leaseState !== "active") return refusalFor(this.leaseState);
    this.inFlight += 1;
    let released = false;
    return {
      lease: this,
      attemptOrdinal: this.attempt,
      release: () => {
        if (released) return;
        released = true;
        this.inFlight -= 1;
        if (this.inFlight === 0) this.resolveQuiet?.();
      },
    };
  }

  /** Records which provider attempt is in flight. Evidence, not an owner. */
  noteAttempt(attemptOrdinal: number): void {
    this.attempt = attemptOrdinal;
  }

  /**
   * Records the correlation a real callback arrived with. Only ever lowers: an
   * exactly correlated call cannot repair a bridge that already lost an ID.
   */
  observeCorrelation(correlation: "provider_id" | "none"): void {
    if (correlation === "none") this.observedCorrelation = "none";
  }

  /**
   * Registers the turn-run owner's notifier, so a callback that crosses an effect
   * boundary refuses the turn's next retry. This is the production writer for
   * that refusal (ADR-0032, ADR-0033).
   */
  onConsequentialCallback(sink: () => void): void {
    this.consequentialSink = sink;
  }

  /**
   * The named effect-boundary check every consequential handler makes before it
   * can no longer prove no outcome.
   *
   * False means refuse *before* crossing, for either of two reasons the handler
   * does not have to distinguish: the generation is signalled or no longer active,
   * or its write-ahead intent could not be made durable (ADR-0033). The ordering,
   * and the re-check that closes the window
   * awaiting the persist opens, live in
   * {@link ../shared/generationAudit.crossWithDurableIntent}.
   */
  crossEffectBoundary(
    boundary: ClaudeCodeEffectBoundary,
    intent: EffectIntentRequest,
  ): Promise<boolean> {
    return crossWithDurableIntent(boundary, intent, {
      isLive: () =>
        this.leaseState === "active" && !this.context.signal?.aborted,
      audit: this.context.audit,
      ownership: () => this.ownership(),
      onCrossed: (crossed) => {
        this.crossed.add(crossed);
        this.consequentialSink?.();
      },
    });
  }

  /**
   * Records the outcome the executor observed, under the lease that admitted it
   * under the lease that admitted it. Never refuses: by here the effect has happened, so
   * there is nothing left to gate.
   */
  reconcileEffect(intent: EffectIntentRequest): Promise<void> {
    return this.context.audit?.reconcileIntent(intent) ?? Promise.resolve();
  }

  /** Which run owned a crossing, for the audit record's evidence fields. */
  private ownership(): EffectRunOwnership {
    return {
      leaseId: this.context.leaseId,
      attemptOrdinal: this.attempt,
    };
  }

  /** Claims the ask barrier for one callback. False when another already holds it. */
  claimAsk(): boolean {
    if (this.askClaimed) return false;
    this.askClaimed = true;
    return true;
  }

  releaseAsk(): void {
    this.askClaimed = false;
  }

  /**
   * Refuses every further admission and resolves once the callbacks already
   * admitted have released. Idempotent; concurrent callers await the same promise.
   */
  beginStopping(): Promise<void> {
    if (this.quiet) return this.quiet;
    if (this.leaseState === "active") this.leaseState = "stopping";
    if (this.inFlight === 0) {
      this.quiet = Promise.resolve();
      return this.quiet;
    }
    this.quiet = new Promise<void>((resolve) => {
      this.resolveQuiet = resolve;
    });
    return this.quiet;
  }

  /** Marks the lease settled. Only valid once nothing is in flight. */
  settle(): void {
    if (this.leaseState === "tombstoned") return;
    this.leaseState = "quiescent";
  }

  /**
   * Retires the lease permanently. Reached by capture failure, hard disposal, and
   * forced settlement, none of which may leave a surface that answers again
   * (ADR-0032). The pending ask is cancelled here because a tombstoned
   * generation can no longer deliver an answer to it.
   */
  tombstone(): void {
    if (this.leaseState === "tombstoned") return;
    this.leaseState = "tombstoned";
    this.context.askResponder?.cancelPending("destroyed");
    this.askClaimed = false;
    this.resolveQuiet?.();
  }
}

function refusalFor(state: ClaudeCodeLeaseState): CallbackRefusal {
  switch (state) {
    case "stopping":
      return "generation_stopping";
    case "quiescent":
      return "generation_settled";
    case "tombstoned":
      return "generation_tombstoned";
    default:
      return "no_active_generation";
  }
}

/**
 * The one mutable cell a Claude callback surface reads.
 *
 * An MCP server instance captures its tool provider for the whole life of the
 * transport it serves, and on the persistent path that is one `claude` process
 * spanning many generations. The slot is what the generation installs into and
 * clears, so the provider closure holds a stable reference while the *lease* it
 * resolves to changes per generation, or is absent.
 *
 * A slot belongs to exactly one callback surface: one persistent SDK session, one
 * one-shot run, or one legacy loopback run. Tombstoning it therefore dies with the
 * session it guards rather than being retained by anything (ADR-0032).
 */
export class ClaudeCodeRunSlot {
  private lease: ClaudeCodeGenerationLease | null = null;
  private tombstoned = false;

  get isEmpty(): boolean {
    return this.lease === null;
  }

  get isTombstoned(): boolean {
    return this.tombstoned;
  }

  /** The installed lease, for the owner that installed it. A callback never reads this. */
  peek(): ClaudeCodeGenerationLease | null {
    return this.lease;
  }

  /**
   * Installs one generation's lease. Refuses a tombstoned slot, and refuses one
   * still holding a prior lease: a new generation may take a surface over only
   * after the previous one proved quiescent (ADR-0032).
   */
  install(lease: ClaudeCodeGenerationLease): boolean {
    if (this.tombstoned || this.lease !== null) return false;
    this.lease = lease;
    return true;
  }

  /** Releases the surface, but only for the lease that holds it. */
  clear(lease: ClaudeCodeGenerationLease): void {
    if (this.lease === lease) this.lease = null;
  }

  /** Retires the surface for good. Its session is gone and must not answer again. */
  tombstone(): void {
    this.tombstoned = true;
    this.lease = null;
  }

  /**
   * The admission point (ADR-0032). Synchronous end to end: it resolves
   * the lease and increments its in-flight count with no `await` in between, so a
   * generation that begins stopping cannot be entered by a callback that already
   * passed the check.
   */
  admit(): CallbackToken | CallbackRefusal {
    if (this.tombstoned) return "generation_tombstoned";
    const lease = this.lease;
    if (!lease) return "no_active_generation";
    return lease.enterCallback();
  }
}

/**
 * One generation's grip on every Claude callback surface it can reach.
 *
 * Created by `ClaudeCodeService.getRuntime()` before the generation's owners
 * exist, activated by the chat pipeline once they do, and released in that
 * pipeline's `finally`. Surfaces register themselves with the handle as they are
 * built, which is what lets a persistent session minted mid-generation adopt the
 * lease that is already running.
 */
export class ClaudeCodeGenerationHandle {
  private lease: ClaudeCodeGenerationLease | null = null;
  private readonly slots = new Set<ClaudeCodeRunSlot>();
  private released = false;

  constructor(
    private readonly scope: ClaudeCodeRuntimeScope,
    /** Run-scoped transport teardown (the legacy loopback server), if any. */
    private readonly onReleased: () => void = () => undefined,
  ) {}

  get leaseId(): string {
    return this.scope.leaseId;
  }

  /** The active lease, or null before activation and after release. */
  get activeLease(): ClaudeCodeGenerationLease | null {
    return this.lease;
  }

  /**
   * Installs the generation's owners. Called once, from the chat pipeline, before
   * the provider can produce a callback. There is no setter that replaces an owner
   * afterwards; a second activation would be a second generation.
   */
  activate(owners: ClaudeCodeGenerationOwners): ClaudeCodeGenerationLease {
    if (this.lease) return this.lease;
    const lease = new ClaudeCodeGenerationLease({ ...this.scope, ...owners });
    this.lease = lease;
    for (const slot of this.slots) slot.install(lease);
    return lease;
  }

  /**
   * Adopts a callback surface. A surface built before activation (the one-shot and
   * legacy servers) is filled when `activate()` runs; a surface built after it (a
   * persistent session minted mid-generation) is filled immediately.
   */
  registerSlot(slot: ClaudeCodeRunSlot): ClaudeCodeRunSlot {
    this.slots.add(slot);
    if (this.lease) slot.install(this.lease);
    return slot;
  }

  /**
   * Stops admitting callbacks, waits for the ones already admitted to release,
   * then settles the lease and empties every surface it held.
   *
   * The caller must resolve anything parked on the user (the live review and the
   * ask coordinator) before awaiting this, or the drain waits on a decision that
   * will never come.
   */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    const lease = this.lease;
    if (lease) {
      await lease.beginStopping();
      lease.settle();
      for (const slot of this.slots) slot.clear(lease);
    }
    this.onReleased();
  }

  /**
   * Forced retirement: capture failure, hard disposal, or plugin unload. Every
   * surface this generation touched refuses forever, and the lease cancels the
   * interaction it can no longer answer. Synchronous, because plugin unload cannot
   * await.
   */
  tombstone(): void {
    this.released = true;
    for (const slot of this.slots) slot.tombstone();
    this.lease?.tombstone();
    this.onReleased();
  }
}

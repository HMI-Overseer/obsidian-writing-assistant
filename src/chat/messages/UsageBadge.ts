import type {
  AssistantReplayEvidence,
  MessageUsage,
  ProviderOption,
  SessionRebuildReason,
} from "../../shared/types";
import { isMeteredProvider } from "../../providers/descriptors";
import { PRICING_AS_OF } from "../../api/pricing";

/**
 * Short, human labels for each cold-rebuild cause, shown next to "synthetic
 * rebuild" in the Claude Code usage tooltip. The interesting measurement signal
 * is a config-driven rebuild (a mode switch changing the prompt / tools), which
 * the prompt-cache work targets; a first-turn mint ("no-session") reads as
 * expected and is handled separately. Idle eviction ("expired") and compaction
 * ("compacted") reach here via the registry's disposal tombstone
 * (ADR-0016).
 */
const SESSION_REBUILD_LABELS: Record<SessionRebuildReason, string> = {
  "no-session": "new",
  "session-disposed": "expired",
  compacted: "compacted",
  "provider-mismatch": "provider changed",
  "model-changed": "model changed",
  "system-prompt-changed": "prompt changed",
  "reasoning-changed": "reasoning changed",
  "agentic-mode-changed": "agentic mode changed",
  "tools-changed": "tools changed",
  "config-changed": "config changed",
  "history-edited": "history edited",
  "turn-count": "history changed",
};

/** Abbreviated count for the compact face (e.g. 12756 → "12.8k"). */
function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

/** Exact count with thousands separators for the tooltip (locale-independent). */
function withThousands(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * The single headline shown on the badge face. Cost is the headline for a metered
 * provider with a known price (what those users watch); everything else (Claude
 * Code's subscription, a metered model with no price table entry, a free local
 * model) falls back to a compact total-token figure. The in/out split, cache, and
 * price basis all move to the tooltip. Pure, unit-tested.
 */
export function buildHeadline(
  usage: MessageUsage,
  provider: ProviderOption | undefined,
): { text: string; isCost: boolean } {
  const hasCost =
    provider !== "claudecode" &&
    usage.estimatedCostUsd !== null &&
    usage.estimatedCostUsd !== undefined &&
    usage.estimatedCostUsd > 0;
  if (hasCost) {
    return { text: `~${formatCost(usage.estimatedCostUsd as number)}`, isCost: true };
  }
  return { text: `${formatTokenCount(usage.inputTokens + usage.outputTokens)} tok`, isCost: false };
}

/**
 * The cache figures shown on the badge face for cache-capable providers
 * (Anthropic, Claude Code): the read total, plus the write total when one was
 * created. Tinted by whether the turn HIT the cache (read > 0, green) or MISSED
 * it (read === 0, amber), a miss means the prefix was reprocessed from scratch.
 * Null when the provider reports no cache fields (OpenAI, LM Studio). Pure,
 * unit-tested.
 */
export function describeCache(
  usage: MessageUsage,
): { text: string; state: "hit" | "miss" } | null {
  if (usage.cacheReadInputTokens === undefined) return null;
  const write =
    usage.cacheCreationInputTokens && usage.cacheCreationInputTokens > 0
      ? ` · ${formatTokenCount(usage.cacheCreationInputTokens)} cache write`
      : "";
  return {
    text: `${formatTokenCount(usage.cacheReadInputTokens)} cache read${write}`,
    state: usage.cacheReadInputTokens > 0 ? "hit" : "miss",
  };
}

/**
 * The full usage breakdown, shown as the badge's hover tooltip (a native
 * multi-line title). Everything the minimal face omits lives here: the in/out
 * split, cache read/write figures, the session reuse reason, the cost basis, and
 * the model id. Pure, unit-tested.
 */
export function composeUsageTooltip(
  usage: MessageUsage,
  modelId: string | undefined,
  provider: ProviderOption | undefined,
  replayEvidence?: AssistantReplayEvidence,
): string {
  const lines: string[] = [
    `${withThousands(usage.inputTokens)} in · ${withThousands(usage.outputTokens)} out`,
  ];

  // Prompt-cache figures, reported by cache-capable providers (Anthropic, Claude
  // Code). A "0 cache read" is the tell that the turn reprocessed its prefix.
  if (usage.cacheReadInputTokens !== undefined) {
    const write =
      usage.cacheCreationInputTokens && usage.cacheCreationInputTokens > 0
        ? ` · ${withThousands(usage.cacheCreationInputTokens)} cache write`
        : "";
    lines.push(`${withThousands(usage.cacheReadInputTokens)} cache read${write}`);
  }

  const session = describeSession(usage);
  if (session) lines.push(session.text);
  if (replayEvidence) {
    lines.push(`Replay fidelity: ${describeReplayFidelity(replayEvidence)}`);
  }

  if (provider === "claudecode") {
    lines.push("Subscription (no per-message cost)");
  } else if (
    usage.estimatedCostUsd !== null &&
    usage.estimatedCostUsd !== undefined &&
    usage.estimatedCostUsd > 0
  ) {
    lines.push(`~${formatCost(usage.estimatedCostUsd)}, estimated, pricing as of ${PRICING_AS_OF}`);
  } else if (usage.estimatedCostUsd === undefined && isMeteredProvider(provider)) {
    lines.push("Price unavailable, no local pricing for this model");
  }

  if (modelId && provider && provider !== "lmstudio") {
    lines.push(`model: ${modelId}`);
  }

  return lines.join("\n");
}

export function renderUsageBadge(
  parentEl: HTMLElement,
  usage: MessageUsage | undefined,
  modelId: string | undefined,
  provider: ProviderOption | undefined,
  replayEvidence?: AssistantReplayEvidence,
): HTMLElement | null {
  // Nothing to show for messages without usage or model info.
  if (!usage && !modelId) return null;

  const badgeEl = parentEl.createDiv({ cls: "lmsa-chat-window-usage-badge" });

  // No usage figures (e.g. an aborted or older message): keep just the model id.
  if (!usage) {
    if (modelId && provider && provider !== "lmstudio") {
      badgeEl.createSpan({ cls: "lmsa-chat-window-usage-model", text: modelId });
    }
    return badgeEl;
  }

  // The face stays minimal; the full breakdown rides the hover tooltip.
  badgeEl.setAttribute(
    "title",
    composeUsageTooltip(usage, modelId, provider, replayEvidence),
  );

  const headline = buildHeadline(usage, provider);
  const headlineEl = badgeEl.createSpan({
    cls: "lmsa-chat-window-usage-headline",
    text: headline.text,
  });
  if (headline.isCost) headlineEl.addClass("is-cost");

  // Cache read/write, surfaced on the face and tinted by hit (green) / miss (amber).
  const cache = describeCache(usage);
  if (cache) {
    const cacheEl = badgeEl.createSpan({
      cls: "lmsa-chat-window-usage-cache",
      text: cache.text,
    });
    cacheEl.addClass(cache.state === "hit" ? "is-hit" : "is-miss");
  }

  // Claude Code only: flag a cold session *rebuild* (the prompt-cache regression).
  // The cause lives in the tooltip; a reused/started session needs no extra word.
  const session = describeSession(usage);
  if (session?.state === "rebuilt") {
    badgeEl.createSpan({
      cls: "lmsa-chat-window-usage-session is-rebuilt",
      text: "synthetic rebuild",
    });
  }

  return badgeEl;
}

/**
 * Human-readable replay surface selected for the committed assistant revision.
 *
 * "Legacy" is read from the reason that actually means it, never inferred from
 * a `segment` plus uncorrelated pair. Those two facts are reachable together on
 * the SDK path (a callback arriving without a provider tool-use ID lowers
 * correlation, and runtime evidence may lower capture order), and an SDK run
 * labelled "legacy" would be a plain lie about which transport served the turn.
 */
/** Whether any of a turn's lowered reasons starts with `prefix`. */
function hasReason(evidence: AssistantReplayEvidence, prefix: string): boolean {
  return (evidence.loweredReason ?? "")
    .split(",")
    .some((reason) => reason.startsWith(prefix));
}

export function describeReplayFidelity(
  evidence: AssistantReplayEvidence,
): string {
  // Reasons compose once runtime placement lowers a turn, so both of these read
  // the reason list rather than assuming a single value. A turn that was lowered
  // for its placement AND served over the legacy transport is still legacy.
  if (hasReason(evidence, "claude_code_legacy_stream_json_capture")) {
    return "degraded legacy capture";
  }
  if (evidence.tier === "native") return "native Claude continuation";
  if (evidence.tier === "structural") return "structural direct replay";
  if (
    hasReason(evidence, "claude_code_") ||
    evidence.capabilities.captureOrder === "exact"
  ) {
    return "textual Claude rebuild";
  }
  return "textual replay";
}

/**
 * Maps a turn's session recovery fields to a label + visual state, or null when the
 * provider doesn't report session reuse (everything but Claude Code). The three-rung
 * recovery ladder (ADR-0016) is mirrored truthfully: `reused` is a win (warm
 * process), `resumed` is the middle rung (the process was gone but the session was
 * restored from disk with its working context intact, only API cache warmth lost),
 * a first-turn `no-session` is a neutral cold mint, and any other rebuild is the
 * fidelity-losing state worth watching. Exported for unit testing and reused by both
 * the face and the tooltip session line.
 *
 * "Synthetic rebuild" is this plugin's own term for a turn served by a session
 * reconstructed from the transcript. It is unrelated to the SDK's
 * `SDKUserMessage.isSynthetic` flag (a per-message "injected by the harness"
 * marker), which we never set.
 */
export function describeSession(
  usage: MessageUsage,
): { text: string; state: "reused" | "resumed" | "started" | "rebuilt" } | null {
  if (usage.sessionReused === undefined) return null;
  if (usage.sessionReused) return { text: "session reused", state: "reused" };
  // Middle rung (ADR-0016): restored from disk, not a warm reuse and not a rebuild.
  if (usage.sessionResumed) return { text: "session resumed", state: "resumed" };
  const reason = usage.sessionRebuildReason;
  if (reason === "no-session") return { text: "session started", state: "started" };
  // Only a genuinely reason-less rebuild (a hand-built / older persisted record)
  // shows the bare label; every real cause, including an idle-evicted
  // `session-disposed` ("expired") and a `compacted` session, names itself now that
  // the disposal tombstone makes those reachable (ADR-0016).
  if (reason === undefined) {
    return { text: "synthetic rebuild", state: "rebuilt" };
  }
  return { text: `synthetic rebuild · ${SESSION_REBUILD_LABELS[reason]}`, state: "rebuilt" };
}

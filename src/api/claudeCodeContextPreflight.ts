import { estimateStringTokens } from "../shared/tokenEstimation";

/**
 * Passive send-path preflight for Claude Code's flat mint blob (cold-rebuild
 * fidelity §6.4, phase 5).
 *
 * With CLI compaction disabled ({@link claudeCodeProcess.claudeCodeHarnessEnv}
 * sets `DISABLE_COMPACT`), the harness no longer summarizes a too-large context
 * mid-turn; an oversized request instead dies at the API with an opaque "Prompt
 * is too long" error (§6.2 Zone 2). This preflight catches that case *before* any
 * spend and surfaces a clear "conversation too large" state instead.
 *
 * It never removes context (§6.4: the user controls anything that removes
 * context); it only refuses to send. It is best-effort: the estimate is the
 * `chars / 4` heuristic and the window is whatever the CLI last reported, so a
 * slight miss either way is acceptable for a passive guard the capacity ring
 * already shadows.
 */

/**
 * Tokens held back from the discovered context window when checking the mint
 * blob, covering everything the blob measurement omits: the model's reply, the
 * `claude_code` preset system prompt, and the MCP tool definitions (all consume
 * window but none ride the blob string). The one tunable number for this phase.
 *
 * Deliberately paired with NOT setting `CLAUDE_CODE_MAX_CONTEXT_TOKENS` (§6.4
 * ratification "flag and preflight must share one number"): a single process-wide
 * env cap cannot serve Claude Code models with different real windows (200k vs
 * 1M), and with compaction off it would only convert this legible plugin-side
 * refusal into an opaque CLI rejection. The per-conversation window this preflight
 * reads is the "upper limit we enforce"; there is no second number to diverge.
 */
export const CLAUDE_CODE_CONTEXT_RESERVE_TOKENS = 24_000;

/**
 * Thrown by {@link assertMintBlobFits} when the assembled mint blob would not
 * leave room for a reply within the discovered context window. Surfaces to the
 * chat layer as an ordinary streamed error (a clear error bubble), the same path
 * SDK/CLI errors take, so no send-path control flow changes are needed.
 */
export class ClaudeCodeContextOverflowError extends Error {
  constructor(
    readonly estimatedTokens: number,
    readonly limit: number,
  ) {
    super(
      "This conversation is too large for Claude Code's context window. " +
        "Start a new conversation, or branch from an earlier message, to continue.",
    );
    this.name = "ClaudeCodeContextOverflowError";
  }
}

/** The blob token budget for a given discovered context window. */
export function mintBlobTokenLimit(contextWindow: number): number {
  return contextWindow - CLAUDE_CODE_CONTEXT_RESERVE_TOKENS;
}

/**
 * Throws {@link ClaudeCodeContextOverflowError} when the mint blob plus the
 * plugin's appended system prompt would overflow the reply-reserved budget of the
 * discovered context window. A no-op when the window is unknown (undefined): the
 * first turn of a conversation has none yet (Claude Code aliases carry no static
 * window and the CLI reports one only after the first result), and a passive guard
 * cannot judge a fit it has no ceiling for.
 */
export function assertMintBlobFits(
  blob: string,
  systemPrompt: string,
  contextWindow: number | undefined,
): void {
  if (!contextWindow) return;
  const estimatedTokens = estimateStringTokens(blob) + estimateStringTokens(systemPrompt);
  const limit = mintBlobTokenLimit(contextWindow);
  if (estimatedTokens > limit) {
    throw new ClaudeCodeContextOverflowError(estimatedTokens, limit);
  }
}

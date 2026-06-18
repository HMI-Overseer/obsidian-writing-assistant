/**
 * One builder for tool *failures*, the read/error-channel analogue of
 * {@link ../vault-ops/disposition.dispositionMessage}: it turns a typed
 * {@link ErrorKind} into a recovery-shaped sentence the model reads, and attaches
 * the structured {@link ToolFailure} consumers branch on. Pure — no Obsidian, no
 * disk — so it is unit-testable.
 *
 * The invariant it defends, enforced here rather than by per-handler discipline:
 * *every* error result names what failed (`what` / `content`) **and** what to try
 * next (`recovery`, defaulting per kind when a handler gives none). Wording rule:
 * plain, accurate, actionable — common words a small model can follow, and never a
 * claim the caller didn't make (the same one-state-two-consumers honesty
 * `dispositionMessage` already holds).
 */

import { assertNever } from "../utils";
import type { ErrorKind, ToolResult } from "./types";

export interface ToolFailureSpec {
  kind: ErrorKind;
  /**
   * Names what failed, as a clause with no leading "Error:" and no trailing period —
   * e.g. `no note found at path "Characters/Will.md"`. Used to compose `content` when
   * `content` is not supplied directly.
   */
  what?: string;
  /**
   * The situated next step, as a clause with no trailing period — e.g.
   * `call list_directory to locate the correct path`. Falls back to a per-kind
   * default when omitted, so the contract holds even for terse handlers.
   */
  recovery?: string;
  /**
   * Pre-composed content, used verbatim instead of composing from `what`/`recovery`.
   * For curated multi-sentence messages (e.g. the semantic_search availability text)
   * that already read as a full recovery contract.
   */
  content?: string;
  /** Read channel (true, default) vs mutation channel (false). */
  isReadOnly?: boolean;
}

/**
 * The general next step for a kind, used when a handler supplies no situated one.
 * Exhaustive: a new {@link ErrorKind} without an arm is a compile error here.
 * Exported so the edit channel ({@link ../chat/actions/liveVaultReview.editError})
 * shares one source of per-kind recovery wording instead of re-inventing it.
 */
export function defaultRecovery(kind: ErrorKind): string {
  switch (kind) {
    case "not-found":
      return "check the path, or use list_directory / search_files to locate it";
    case "invalid-args":
      return "check the arguments against the tool's schema and retry";
    case "no-match":
      return "broaden or rephrase the query, or re-read the source first";
    case "ambiguous":
      return "narrow the input to a single target and retry";
    case "precondition":
      return "resolve the noted condition, then retry";
    case "unavailable":
      return "use a different tool instead";
    case "denied":
      return "do not retry it; the action is blocked by policy";
    case "failed":
      return "verify the current state and retry only if it is safe to";
    default:
      return assertNever(kind);
  }
}

/** Strip a single trailing period so we control terminal punctuation uniformly. */
export function trimDot(text: string): string {
  return text.endsWith(".") ? text.slice(0, -1) : text;
}

/**
 * Build a failure {@link ToolResult}. Composes `Error: <what>. <recovery>.` when
 * `content` is not given (the read-channel form the system prompt keys off the
 * "Error:" prefix for), and always attaches the structured `failure`.
 */
export function toolFailure(spec: ToolFailureSpec): ToolResult {
  const recovery = spec.recovery ?? defaultRecovery(spec.kind);

  let content: string;
  if (spec.content !== undefined) {
    content = spec.content;
  } else {
    const what = spec.what ? trimDot(spec.what) : "the tool call failed";
    content = `Error: ${what}. ${trimDot(recovery)}.`;
  }

  return {
    content,
    isReadOnly: spec.isReadOnly ?? true,
    isError: true,
    failure: { kind: spec.kind, recovery },
  };
}

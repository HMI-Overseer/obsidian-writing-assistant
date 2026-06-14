import type { ConversationMessage } from "../../shared/types";

/**
 * Finalise every prior proposal at a user-turn boundary (Finding B / spec §3-B).
 *
 * A proposal is *live* only during the turn that created it; the next **user**
 * message supersedes it under one law applied to both channels:
 *
 *   - **Pending work is rejected.** An un-applied edit hunk or ask-gated vault op
 *     left behind when the user moves on is implicit feedback — a rejection,
 *     identical to the edit channel's long-standing behaviour. Their Apply/Skip
 *     controls go away because the rows are no longer pending.
 *   - **Applied vault batches are marked historical.** They touched disk, so undo
 *     stays *possible* — but the panel renders a locked, compact variant rather
 *     than a live Undo footer competing with the current turn.
 *
 * Edit-channel applied hunks keep their per-hunk inline undo (no competing footer
 * to demote — re-skinning that is Finding C), so this helper only flips the
 * `historical` flag on vault proposals.
 *
 * **Invariant:** this MUST run only at user-message boundaries, never per
 * tool-loop round — otherwise an agentic multi-round turn would cancel its own
 * earlier proposals (§3-B). Both the API providers and the Claude Code provider
 * route a user turn through `sendMessage`, so calling it there covers both.
 *
 * @returns whether anything changed, so the caller can persist + re-render.
 */
export function supersedePriorProposals(history: ConversationMessage[]): boolean {
  let changed = false;

  for (const msg of history) {
    if (msg.editProposal) {
      for (const hunk of msg.editProposal.hunks) {
        if (hunk.status === "pending") {
          hunk.status = "rejected";
          changed = true;
        }
      }
    }

    if (msg.vaultOpProposal) {
      for (const op of msg.vaultOpProposal.ops) {
        if (op.status === "pending" || op.status === "accepted") {
          op.status = "rejected";
          changed = true;
        }
      }
      if (!msg.vaultOpProposal.historical) {
        msg.vaultOpProposal.historical = true;
        changed = true;
      }
    }
  }

  return changed;
}

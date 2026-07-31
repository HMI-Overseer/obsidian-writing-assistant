// RFC-0011's live Obsidian walk, as a scenario (RFC-0013 Stage 3, plan section 6).
//
// RFC-0011 carries "Perform the live Obsidian walk" as a literal item on its Phase 6 acceptance
// gate, written out for execution in that phase's run record as eight numbered steps. That step
// had to be redone by hand after every change, produced nothing anyone could re-read, and its
// result was a memory. This is that walk, in the repository, leaving an artifact.
//
// Its own words, and where each lands:
//
//   1. Baseline turn. "Search my vault for notes about X, then create a short summary note."
//      One ToolSearch row (not two), prose between the tool rows, the write review attached to
//      the write_file item itself.                              -> the first turn, and its shots
//   2. Approval latency. The pause between the click and the effect is the write-ahead intent
//      persisting, and nothing measures it today.               -> BRACKETED, not measured. The
//      ledger times two things around it, and neither is the persist: `interaction-submitted` is
//      the drawer clearing, which happens *before* the intent is written, and `turn-settled` is
//      the end of a whole further provider round. The persist is somewhere inside the second
//      number. Isolating it needs a checkpoint between the two that no durable state supports,
//      so the gap RFC-0011's own Phase 7 record names is still open and is still named
//   3. Stop, four times: during prose, during tool arguments, while a review is open, after a
//      tool result.                                             -> two of the four, below
//   4. Immediately re-send after a Stop. No row or review from the previous turn.  -> the third
//      turn
//   5. Force a capture failure.                                 -> NOT here. Forcing one live
//      needs a snapshot subscriber made to throw, which is a production edit. The scripted
//      `capture-conflict` scenario drives the same path deterministically and is the honest place
//      for it; a live run cannot fake it and should not pretend to
//   6. Kill Obsidian mid-review.                                -> `live-orphan-recovery`
//   7. Reload after an ordinary failed turn.                    -> `live-orphan-recovery`
//   8. Both themes, and once at a narrow sidebar width.         -> theme is a run's identity, so
//      both themes is two runs. The narrow width is NOT driven: nothing here resizes the
//      workspace split, and `dev/visual` covers narrow rendering statically
//
// Two of the four stops are here rather than all four, and the reason is not effort. "Stop during
// tool arguments" and "stop after a tool result" are moments, not states, and a predicate over
// state() is edge-blind: a scenario aiming at either would in practice stop wherever the model
// happened to be, then report that as the moment it aimed for, which is the one lie this
// instrument exists to prevent. What each stop below actually caught is in the transcript.

import {
  APPROVAL_APPROVE,
  APPROVAL_SUBMIT,
  CHAT_ROOT,
  COMPOSER_DRAWER,
  COMPOSER_STOP,
} from "../lib/scenarioApi.mjs";

/** A real harness turn with a search and a write in it takes minutes, not seconds. */
const LIVE_TURN_TIMEOUT_MS = 300_000;

export default {
  id: "live-rfc0011-walk",
  description: "RFC-0011's live Obsidian walk: search, write, approve, stop, re-send.",
  vault: "writing-basic",
  theme: "dark",
  // The walk is written for the Claude Code harness by name: its first item is about ToolSearch
  // rows, which no other provider produces. Pinning it means the picker asks only for the model.
  provider: { kind: "live", only: "claudecode" },
  // The gate the walk depends on, declared rather than assumed. Credentials and the rest of the
  // provider configuration come from the installed plugin's settings; this says the walk is about
  // Claude Code with the tool loop on and the ask gate armed, and fails visibly if that is not
  // the state it got.
  settings: {
    agenticMode: true,
    providerSettings: { claudecode: { enabled: true } },
  },

  async run(app) {
    await app.shot("the model, before the walk");

    // 1. The baseline turn: something that thinks, searches, then writes.
    await app.send(
      "Search my vault for notes about the lighthouse, then write a short summary note at " +
        "Tower-summary.md. Keep it to three sentences.",
    );
    await app.awaitCheckpoint("turn-started", LIVE_TURN_TIMEOUT_MS);
    await app.shot("the turn, in flight");

    // The write review, attached to the write_file item itself.
    await app.awaitCheckpoint("approval-raised", LIVE_TURN_TIMEOUT_MS);
    await app.shot("the write review, raised");
    await app.shot("the drawer alone", { selector: COMPOSER_DRAWER });

    // 2. Approval latency. The click, then the durable intent, then the effect. The two
    //    checkpoints below bracket the persist and neither isolates it: the lane clears first,
    //    and the next durable state is a settled turn a provider round later. Both times are in
    //    the ledger, so what is known is written down and what is not is not implied.
    await app.click(APPROVAL_APPROVE);
    await app.click(APPROVAL_SUBMIT);
    await app.awaitCheckpoint("interaction-submitted");
    await app.shot("approved, the moment the drawer cleared");

    await app.awaitCheckpoint("turn-settled", LIVE_TURN_TIMEOUT_MS);
    await app.shot("the baseline turn, settled");
    await app.shot("the timeline", { selector: CHAT_ROOT });

    // 3a. Stop during the turn. Where it lands is the model's business; what it settled as is
    //     the claim, and the transcript carries it.
    await app.send("Now rewrite that summary at length, in a much more formal voice.");
    await app.awaitCheckpoint("turn-started", LIVE_TURN_TIMEOUT_MS);
    await app.click(COMPOSER_STOP);
    await app.awaitCheckpoint("turn-settled", LIVE_TURN_TIMEOUT_MS);
    await app.shot("stopped mid-turn");

    // 4. Immediately re-send. The next turn must carry no row or review from the stopped one.
    await app.send("In one sentence: how long has the lighthouse been unlit?");
    await app.awaitCheckpoint("turn-started", LIVE_TURN_TIMEOUT_MS);
    await app.awaitCheckpoint("turn-settled", LIVE_TURN_TIMEOUT_MS);
    await app.shot("the turn after a stop, carrying nothing from it");

    // 3b. Stop with a review open, which is the one that exercises the post-persist re-check.
    await app.send("Write a second summary note at Voice-summary.md, three sentences.");
    await app.awaitCheckpoint("approval-raised", LIVE_TURN_TIMEOUT_MS);
    await app.shot("a review open, about to be stopped");
    await app.click(COMPOSER_STOP);
    await app.awaitCheckpoint("turn-settled", LIVE_TURN_TIMEOUT_MS);
    await app.shot("stopped with a review open");
    await app.shot("the walk, as it ended", { selector: CHAT_ROOT });
  },
};

// Items 6 and 7 of RFC-0011's live walk: the app dies with an authorized action in flight, and
// what the conversation says about it afterwards (RFC-0013 Stage 3).
//
// This is the one item on that walk with no other instrument behind it. ADR-0033's orphan
// recovery has never been exercised by a real crash: its only inputs to date are hand-written
// audit files in a conversation fixture, which is the gap the Phase 7 run record names as
// "killing Obsidian mid-review is the honest test, and it is in the walk checklist".
//
// What this drives is a **renderer reload**, not a process kill, and the difference is stated
// rather than glossed. A reload destroys exactly what a kill destroys of the turn: every scrap of
// in-memory generation state, the tool loop, and the provider run, and it reloads the plugin from
// disk so recovery runs against whatever the audit actually reached. What it does not exercise is
// the main process dying. If that distinction turns out to matter, a kill-and-relaunch mode is
// the named next step, and it is a driver change rather than a scenario one.
//
// The window is genuinely racy and the scenario does not pretend otherwise. The reload is fired
// once `interaction-submitted` says the drawer has cleared, which is the earliest moment the
// approval is known to have been consumed, so the intent persist is under way. Landing before the
// persist leaves nothing to recover; landing after the write completes leaves nothing to recover
// either. Which of the three happened is in the artifact, and the shot after the reload is the
// evidence, not a claim.
//
// What RFC-0011 says should be there, once recovery has run:
//
//   one failed turn reading "This turn ended without finishing. One action had already been
//   authorized, and its outcome could not be confirmed.", rendered as the empty state, appearing
//   exactly once no matter how many times you reload, offering no Approve, Decline, or Apply.

import { APPROVAL_APPROVE, APPROVAL_SUBMIT, CHAT_ROOT } from "../lib/scenarioApi.mjs";

const LIVE_TURN_TIMEOUT_MS = 300_000;

export default {
  id: "live-orphan-recovery",
  description: "Approve a write, kill the renderer under it, and read what recovery left.",
  vault: "writing-basic",
  theme: "dark",
  // Provider-neutral: any model that reaches for a write tool raises the review this needs. It is
  // the plugin's recovery path under test, not the harness.
  provider: { kind: "live" },
  settings: { agenticMode: true },

  async run(app) {
    await app.send("Write a two-sentence note at Recovery.md summarizing Voice.md.");
    await app.awaitCheckpoint("turn-started", LIVE_TURN_TIMEOUT_MS);

    await app.awaitCheckpoint("approval-raised", LIVE_TURN_TIMEOUT_MS);
    await app.shot("the write review, raised");

    await app.click(APPROVAL_APPROVE);
    await app.click(APPROVAL_SUBMIT);
    // The moment the lane clears: the approval has been consumed and the write-ahead intent is
    // being persisted. Not a duration, and not a guess about one.
    await app.awaitCheckpoint("interaction-submitted");

    await app.reload();
    await app.shot("after the reload, the turn as recovery left it");
    await app.shot("the transcript, after recovery", { selector: CHAT_ROOT });

    // Exactly once, no matter how many times you reload.
    await app.reload();
    await app.shot("after a second reload, still one failed turn");
  },
};

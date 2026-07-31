// The Stage 1 gate, as a committed scenario (RFC-0013 plan section 4.3).
//
// It is meant to fail. The failure mode this whole instrument exists to remove is a scenario
// whose click misses and which then screenshots a perfectly plausible earlier state under the
// label of a later one, so the maintainer reviews a picture of the wrong moment believing it is
// the right one. This scenario is that mistake, made on purpose, so the mechanism that catches
// it can be re-checked after any refactor rather than trusted from memory.
//
// Reading the outcome: the run directory holds `01-prompt-typed.png` and nothing after it, its
// manifest says `"complete": false`, and its sheet draws the missed click as a red gap. The
// "turn settled" shot below is never taken, which is the point.
//
// Its sibling `_selftest-missing-checkpoint` covers the other half of the same assertion.

import { COMPOSER_TEXTAREA } from "../lib/scenarioApi.mjs";

/** The send button is `.lmsa-chat-composer-send-btn`. This is deliberately not it. */
const NOT_THE_SEND_BUTTON = ".lmsa-chat-composer-send";

export default {
  id: "_selftest-missed-click",
  description: "Clicks a selector that does not exist. Must fail visibly, not screenshot on.",
  vault: "writing-basic",
  theme: "dark",
  provider: { kind: "scripted", frames: "prose-turn" },
  // Declared, so a suite run can say "failed as designed" and can say the opposite,
  // loudly, on the day this one starts passing.
  mustFail: true,

  async run(app) {
    await app.click(COMPOSER_TEXTAREA);
    await app.type("Tighten the opening of chapter one.");
    await app.shot("prompt typed");

    await app.click(NOT_THE_SEND_BUTTON);

    // Unreachable. If either of these ever runs, the instrument has stopped noticing a missed
    // click, and the shot below is exactly the lie it was built to prevent.
    await app.awaitCheckpoint("turn-settled");
    await app.shot("turn settled");
  },
};

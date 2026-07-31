// The other half of the Stage 1 gate (RFC-0013 plan section 4.3).
//
// `_selftest-missed-click` proves that an action which never landed stops the run. This proves
// the same for a checkpoint that never arrives, which is the failure RFC-0013 actually names:
// "a scenario whose click misses, whose checkpoint never arrives, and which screenshots a
// perfectly plausible earlier state under the label of a later one".
//
// Both kinds go into one ledger and draw through one renderer, so this also keeps the red gap
// itself honest: if the sheet ever started omitting what a run failed to reach, both self-tests
// would go quiet together and one run of either would say so.
//
// It sends nothing, so nothing can settle. The short timeout is the point: this is a self-test,
// not a wait, and it should cost seconds rather than the ceiling a real scenario deserves.

const NEVER_MS = 5_000;

export default {
  id: "_selftest-missing-checkpoint",
  description: "Waits for a turn it never starts. Must fail visibly with a red gap.",
  vault: "writing-basic",
  theme: "dark",
  provider: { kind: "scripted", frames: "prose-turn" },
  // Declared, so a suite run can say "failed as designed" and can say the opposite,
  // loudly, on the day this one starts passing.
  mustFail: true,

  async run(app) {
    await app.shot("nothing sent");

    await app.awaitCheckpoint("turn-settled", NEVER_MS);

    // Unreachable, and the reason this file exists: a shot taken here would carry the label of a
    // moment that never happened.
    await app.shot("turn settled");
  },
};

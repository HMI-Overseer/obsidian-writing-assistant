// The same frame key with different bytes: an ADR-0031 capture conflict (RFC-0013).
//
// The sibling of `duplicate-frame`, and the interesting half. A redelivered batch id whose facts
// fingerprint differently means the transcript is no longer authoritative, so the plugin retires
// the conflicting declaration's batch, publishes one terminal snapshot, and stops the provider
// before anything acts on it.
//
// **This scenario is expected to end on a failed turn**, and that is the evidence, not a
// malfunction. The run itself is complete: every checkpoint it waits for arrives, because a
// failed turn is a settled turn. What a reader judges is the turn panel saying `failed` and the
// transcript carrying a `capture_conflict_fingerprint_mismatch` diagnostic, plus whatever the
// renderer console says, which on this path is the one run where console output is expected.

import { CHAT_ROOT } from "../lib/scenarioApi.mjs";

export default {
  id: "capture-conflict",
  description: "One frame key redelivered with different bytes. The turn must fail, visibly.",
  vault: "writing-basic",
  theme: "dark",
  provider: { kind: "scripted", frames: "capture-conflict" },

  async run(app) {
    await app.send("Give me one sentence about the tower.");

    await app.awaitCheckpoint("turn-started");
    // A failed turn is a settled turn, so this arrives. The status is what carries the finding.
    await app.awaitCheckpoint("turn-settled");

    await app.shot("the conflict, settled as a failed turn");
    await app.shot("what the transcript kept", { selector: CHAT_ROOT });
  },
};

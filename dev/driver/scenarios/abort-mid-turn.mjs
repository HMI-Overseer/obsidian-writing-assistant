// Stop a turn while it is streaming, and see what it settles as (ADR-0032, RFC-0013).
//
// This is the scenario that pays for the scripted client going *through* `createOwnedStreamRun`
// rather than around it. The stop button aborts the generation's controller, the owned run
// cancels its attempt, the generator unwinds, and the turn is persisted as `interrupted`. A
// hand-rolled fake would have had to reimplement all of that, and would then be evidence about
// itself.
//
// Nothing here waits out a duration. The scenario waits for `turn-started`, which is a predicate,
// and the script's frames are paced slowly enough that the turn is still in flight when the click
// lands. If it ever is not, the stop affordance is not on screen and the click fails loudly
// naming the selector, which is the correct failure rather than a screenshot of a settled turn
// captioned "streaming".

import { CHAT_ROOT, COMPOSER_STOP } from "../lib/scenarioApi.mjs";

export default {
  id: "abort-mid-turn",
  description: "Stop a streaming turn from the composer, and read what it settled as.",
  vault: "writing-basic",
  theme: "dark",
  provider: { kind: "scripted", frames: "slow-prose" },

  async run(app) {
    await app.send("Rewrite the opening of chapter one at length.");

    await app.awaitCheckpoint("turn-started");
    await app.shot("streaming, with the send button showing stop");

    await app.click(COMPOSER_STOP);
    await app.awaitCheckpoint("turn-settled");

    await app.shot("settled after the stop");
    await app.shot("the interrupted turn, in the transcript", { selector: CHAT_ROOT });
  },
};

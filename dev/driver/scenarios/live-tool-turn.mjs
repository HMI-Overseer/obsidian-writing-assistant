// One turn against a real model, asked to reach for a tool (RFC-0013 Stage 3).
//
// This is the matrix scenario, and it is short on purpose: a matrix pays a whole Obsidian launch
// per model, and what it is comparing is whether a model reads a note when asked to and answers
// from what it read.
//
// That comparison is the point of the mode. The standing judgements about local models in this
// project are suspect because each model was seen once, under conditions nobody can now
// reconstruct, and because a loop bug discarded successful rounds while those judgements were
// being formed. The same prompt, the same fixture vault, and the same checkpoints beside each
// result is what makes them comparable at all.
//
// The answer is checkable without trusting the model: the lighthouse in `Chapters/One.md` has not
// been lit in eleven years, and nothing else in the vault says so. A model that answers without a
// tool step has either guessed or been fed the note some other way, and the timeline says which.

import { CHAT_ROOT } from "../lib/scenarioApi.mjs";

/** A real model, on a real machine, is slower than a scripted one by orders of magnitude. */
const LIVE_TURN_TIMEOUT_MS = 300_000;

export default {
  id: "live-tool-turn",
  description: "A real model, asked to read a note and answer from it. The matrix scenario.",
  vault: "writing-basic",
  theme: "dark",
  provider: { kind: "live" },

  async run(app) {
    await app.shot("the model, before the turn");

    await app.send(
      "Read the note Chapters/One.md, then answer in one sentence: " +
        "how long has the lighthouse been unlit?",
    );

    await app.awaitCheckpoint("turn-started", LIVE_TURN_TIMEOUT_MS);
    await app.shot("the turn, in flight");

    await app.awaitCheckpoint("turn-settled", LIVE_TURN_TIMEOUT_MS);
    await app.shot("the turn, settled");
    await app.shot("the timeline", { selector: CHAT_ROOT });
  },
};

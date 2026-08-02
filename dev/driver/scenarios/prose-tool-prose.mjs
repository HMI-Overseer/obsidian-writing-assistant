// Prose, a tool step, then more prose: the shape almost every agentic turn has (RFC-0013).
//
// The tool is a read, deliberately. A write would stop at the ask gate and this scenario would
// become one of the approval ones; what it is here to show is the plain case, an executed step
// sitting between two pieces of prose with its arguments and its result on the timeline.
//
// It is also the first script with two rounds. One `ChatClient.stream()` call is one provider
// response, and the plugin streams again after it executes a tool, so the script's frames are
// partitioned at `turn_end`. Without that the scripted client would replay round one on every
// call and the loop would spin to its round cap.

import { CHAT_ROOT } from "../lib/scenarioApi.mjs";

export default {
  id: "prose-tool-prose",
  description: "Prose, a read step, then more prose. Two scripted rounds.",
  vault: "writing-basic",
  theme: "dark",
  provider: { kind: "scripted", frames: "prose-tool-prose" },

  async run(app) {
    await app.send("What is wrong with the opening of chapter one?");

    await app.awaitCheckpoint("turn-started");
    // `tool-step-rendered` is unavailable and asking for it fails naming the reason: a step that
    // completes inside one evaluation window is invisible to a level predicate. So the step is
    // read from the settled turn instead, which is weaker and is stated as weaker.
    await app.awaitCheckpoint("turn-settled");

    await app.shot("both rounds settled, the read step between them");
    await app.shot("the turn, in the transcript", { selector: CHAT_ROOT });
  },
};

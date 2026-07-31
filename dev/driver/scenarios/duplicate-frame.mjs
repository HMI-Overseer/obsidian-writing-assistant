// A frame delivered twice, byte for byte: ADR-0031 redelivery (RFC-0013).
//
// Not on the RFC's Stage 2 list, and nearly free, which is why it is here. No other instrument in
// this project reaches it: the unit suite proves the builder refuses a duplicate batch, and the
// visual harness renders static HTML, so nothing has ever shown redelivery surviving the whole
// path from a provider frame to rendered prose.
//
// The script repeats `dup:delta-1` with identical facts. A batch id is `${leaseId}:${frameKey}`
// and both frames are in one attempt, so the second is the same batch arriving again and must
// apply nothing. The prose is authored so that a failure reads on sight: the settled turn says
// "The tower had been shut for eleven years when Mara went up it", and a redelivery that applied
// twice would say "The tower had been shut for The tower had been shut for eleven years".

import { CHAT_ROOT } from "../lib/scenarioApi.mjs";

export default {
  id: "duplicate-frame",
  description: "One frame key delivered twice, byte for byte. The prose must appear once.",
  vault: "writing-basic",
  theme: "dark",
  provider: { kind: "scripted", frames: "duplicate-frame" },

  async run(app) {
    await app.send("Give me one sentence about the tower.");

    await app.awaitCheckpoint("turn-started");
    await app.awaitCheckpoint("turn-settled");

    await app.shot("the redelivered frame, applied once");
    await app.shot("the prose, in the transcript", { selector: CHAT_ROOT });
  },
};

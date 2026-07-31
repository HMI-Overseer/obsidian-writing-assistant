// Regenerate a turn that has already settled (RFC-0013).
//
// The affordance was checked against the tree rather than against the RFC. A retry action was
// removed from the transcript controls (commit 39421b2); what remains is the bubble action
// toolbar's `regenerate` button, rendered only on the **last** assistant message, so the
// selector needs no scoping. The toolbar sits at `opacity: 0` until its message is hovered,
// which is why `hover` comes before the shot: a picture of the affordance has to be a picture of
// it visible.
//
// This scenario is what forced `turn-settled` to compare *which* revisions are settled rather
// than how many. A regeneration replaces the active revision of a message that already counted,
// so the count is one before and one after, and a count predicate would have waited out its
// whole timeout on a turn that had finished. The fix stayed a read; D12's reserve is unspent.
//
// It reuses the `prose-turn` frames, because the client is built per generation and its round
// cursor starts again with it. The two revisions therefore carry the same prose, and what the
// transcript shows is a second revision with `origin: "regenerated"` beside the first.

import { CHAT_ROOT, REGENERATE } from "../lib/scenarioApi.mjs";

export default {
  id: "regenerate-settled-turn",
  description: "Settle a turn, then regenerate it from the bubble's own action toolbar.",
  vault: "writing-basic",
  theme: "dark",
  provider: { kind: "scripted", frames: "prose-turn" },

  async run(app) {
    await app.send("Tighten the opening of chapter one.");
    await app.awaitCheckpoint("turn-started");
    await app.awaitCheckpoint("turn-settled");
    await app.shot("the first turn, settled");

    await app.hover(REGENERATE);
    await app.shot("the regenerate action, revealed by hover");

    await app.click(REGENERATE);
    await app.awaitCheckpoint("turn-started");
    await app.awaitCheckpoint("turn-settled");

    await app.shot("the regenerated revision, settled");
    await app.shot("the transcript, with both revisions on one message", { selector: CHAT_ROOT });
  },
};

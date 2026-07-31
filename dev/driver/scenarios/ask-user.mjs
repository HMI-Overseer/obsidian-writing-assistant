// `ask_user`, raised in the composer drawer and answered (RFC-0013).
//
// The other half of the drawer. It shares the mount point with approvals and nothing else, so
// this is what proves the `ask-raised` predicate reads a different lane from `approval-raised`
// rather than the same boolean twice.
//
// The barrier below it is real: `planAskBarrierBatch` owns a fresh batch carrying `ask_user`
// before any other executor sees it, and the loop suspends on the answer.

import { ASK_SUBMIT, askOption, CHAT_ROOT, COMPOSER_DRAWER } from "../lib/scenarioApi.mjs";

export default {
  id: "ask-user",
  description: "An ask_user question raised in the composer drawer, answered, then more prose.",
  vault: "writing-basic",
  theme: "dark",
  provider: { kind: "scripted", frames: "ask-user" },

  async run(app) {
    await app.send("Rewrite the opening of chapter one.");

    await app.awaitCheckpoint("ask-raised");
    await app.shot("ask_user raised in the composer drawer");
    await app.shot("the drawer alone", { selector: COMPOSER_DRAWER });

    // Question 1, option 1, numbered from zero exactly as the form's own ids number them.
    await app.click(askOption(0, 0));
    await app.shot("an answer chosen, before submit");

    await app.click(ASK_SUBMIT);
    await app.awaitCheckpoint("interaction-submitted");

    await app.awaitCheckpoint("turn-settled");
    await app.shot("the answer on the tool result, and the second round after it");
    await app.shot("the turn, in the transcript", { selector: CHAT_ROOT });
  },
};

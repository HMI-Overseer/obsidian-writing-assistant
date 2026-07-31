// One scripted prose turn, typed by hand and waited on by name (RFC-0013).
//
// This is Stage 0's walk, in the shape the scenario loader validates. Its two inline waits are
// now named checkpoints from the registry, which is the only change to what it does.

import { CHAT_ROOT, COMPOSER_SEND, COMPOSER_TEXTAREA } from "../lib/scenarioApi.mjs";

export default {
  id: "prose-turn",
  description: "Type a prompt, stream one scripted prose turn, settle.",
  vault: "writing-basic",
  theme: "dark",
  provider: { kind: "scripted", frames: "prose-turn" },

  async run(app) {
    // Real input only. `ChatView.seedPrompt` exists and is tempting; a scenario that seeds the
    // composer through a method is not exercising the composer.
    await app.click(COMPOSER_TEXTAREA);
    await app.type("Tighten the opening of chapter one.");
    await app.shot("prompt typed");

    await app.click(COMPOSER_SEND);

    // Both are predicates over the bridge's own state(), never a duration. `turn-started` first,
    // so `turn-settled` cannot be satisfied by a turn that has not begun.
    await app.awaitCheckpoint("turn-started");
    await app.awaitCheckpoint("turn-settled");

    await app.shot("turn settled");
    await app.shot("chat settled", { selector: CHAT_ROOT });
  },
};

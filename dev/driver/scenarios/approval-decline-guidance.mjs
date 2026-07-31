// RFC-0013's own worked example: declining an edit sends guidance on the tool result.
//
// Same script as `approval-approve`, opposite decision. That pairing is the point: one authored
// proposal, two answers, two outcomes, and the difference is entirely the plugin's, not the
// provider's.
//
// The RFC's version of this scenario clicked `.lmsa-approval-form-decision` to choose and
// `.lmsa-approval-form-submit` to submit. Only the second exists as written: the first is the
// `<fieldset>` wrapping all three choices, so clicking it would have landed wherever its centre
// fell. The decline row is the "Other" option, and selecting it is what reveals the guidance
// field, which is why the click below is followed by a click into a textarea that is hidden
// until that moment.

import {
  APPROVAL_DECLINE,
  APPROVAL_GUIDANCE,
  APPROVAL_SUBMIT,
  CHAT_ROOT,
  COMPOSER_DRAWER,
} from "../lib/scenarioApi.mjs";

export default {
  id: "approval-decline-guidance",
  description: "Declining a write in the composer drawer sends guidance on the tool result.",
  vault: "writing-basic",
  theme: "dark",
  provider: { kind: "scripted", frames: "vault-write" },

  async run(app) {
    await app.send("Draft chapter two and save it.");

    await app.awaitCheckpoint("approval-raised");
    await app.shot("approval raised in the composer drawer");

    await app.click(APPROVAL_DECLINE);
    await app.click(APPROVAL_GUIDANCE);
    await app.type("No, keep the original voice. Do not write the file yet.");
    await app.shot("decline with guidance, before submit");
    await app.shot("the drawer alone", { selector: COMPOSER_DRAWER });

    await app.click(APPROVAL_SUBMIT);
    await app.awaitCheckpoint("interaction-submitted");

    await app.awaitCheckpoint("turn-settled");
    await app.shot("guidance rides back on the tool result");
    await app.shot("the turn, in the transcript", { selector: CHAT_ROOT });
  },
};

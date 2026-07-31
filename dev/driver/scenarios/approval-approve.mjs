// A write the ask gate stops on, approved through the composer drawer (RFC-0012, RFC-0013).
//
// The write is real: `write_file` goes through the plugin's own tool loop, the ask gate parks it
// on the user, and approving it creates `Chapters/Two.md` inside the scratch vault. That is what
// the disposable vault is for, and it is why the tool result on the timeline is evidence about
// the vault rather than about the script.
//
// The Approve row is clicked rather than relied on. The form opens on Approve already selected,
// so a scenario that only pressed Submit would keep passing if that default ever moved, and
// would then be evidence about nothing.

import {
  APPROVAL_APPROVE,
  APPROVAL_SUBMIT,
  CHAT_ROOT,
  COMPOSER_DRAWER,
} from "../lib/scenarioApi.mjs";

export default {
  id: "approval-approve",
  description: "A write_file stopped at the ask gate, approved in the composer drawer.",
  vault: "writing-basic",
  theme: "dark",
  provider: { kind: "scripted", frames: "vault-write" },

  async run(app) {
    await app.send("Draft chapter two and save it.");

    await app.awaitCheckpoint("approval-raised");
    await app.shot("approval raised in the composer drawer");
    await app.shot("the drawer alone", { selector: COMPOSER_DRAWER });

    await app.click(APPROVAL_APPROVE);
    await app.click(APPROVAL_SUBMIT);
    await app.awaitCheckpoint("interaction-submitted");

    await app.awaitCheckpoint("turn-settled");
    await app.shot("approved, and the write reported on the tool result");
    await app.shot("the turn, in the transcript", { selector: CHAT_ROOT });
  },
};

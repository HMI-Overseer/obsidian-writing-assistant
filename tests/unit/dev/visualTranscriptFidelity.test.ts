import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

const SCAFFOLD = source("dev/visual/scaffold.mjs");
const CHAT = source("dev/visual/fixtures/chat.mjs");
const ASK = source("dev/visual/fixtures/ask.mjs");
const APPROVAL = source("dev/visual/fixtures/approval.mjs");

/**
 * The harness exists to make a glaring regression obvious on sight. That only works if what
 * it draws is the plugin's own chrome: a surface rendered in invented markup cannot show a
 * regression in real markup, and a family where some surfaces are real and some are not is
 * worse than either, because a reader cannot tell which is which without reading the fixture.
 *
 * The drawer stages used to paint their own conversation, simple rounded bubbles with
 * scaffold-only styling, which looked nothing like the transcript. These pin the fix.
 */
describe("visual harness renders the plugin's transcript, not a stand-in", () => {
  it("defines no invented message chrome in the scaffold", () => {
    // The scaffold may neutralize positioning and host harness-only probes; it may not
    // invent the appearance of a component that exists in the plugin.
    expect(SCAFFOLD).not.toContain("visual-bubble");
    expect(SCAFFOLD).not.toContain("visual-transcript");
    expect(SCAFFOLD).not.toMatch(/border-radius:\s*14px/u);
  });

  it("builds message chrome once, from the transcript's real class names", () => {
    for (const helper of ["userMessage", "assistantProse", "messagesPane"]) {
      expect(CHAT, `chat fixtures should export ${helper}`).toContain(
        `export const ${helper}`,
      );
    }
    expect(CHAT).toContain("lmsa-chat-window-message--user");
    expect(CHAT).toContain("lmsa-chat-window-message-body lmsa-ui-card");
    expect(CHAT).toContain("lmsa-chat-window-message-content--markdown");
    expect(CHAT).toContain("lmsa-chat-window-messages");
  });

  it("uses those helpers behind both drawers", () => {
    for (const [name, fixture] of [
      ["ask", ASK],
      ["approval", APPROVAL],
    ] as const) {
      expect(fixture, `${name} stage should mount the real messages pane`).toContain(
        "messagesPane(",
      );
      expect(fixture, `${name} stage should use the real user message`).toContain(
        "userMessage(",
      );
      expect(fixture, `${name} stage should not paint its own bubbles`).not.toContain(
        "visual-bubble",
      );
    }
  });

  it("keeps the transcript surface on the same helpers, so the two cannot drift", () => {
    const transcript = source("dev/visual/surfaces/transcript.mjs");
    expect(transcript).toContain("userMessage(");
    expect(transcript).toContain("messagesPane(");
  });
});

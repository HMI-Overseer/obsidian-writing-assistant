import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
// @ts-expect-error the driver is plain ESM outside the typechecked source tree (plan D6).
import { createTerminal, isTerminalClosed } from "../../../dev/driver/lib/picker.mjs";

/**
 * Who owns stdin, and when (RFC-0013 plan section 4.1).
 *
 * The menu's own state machine is covered next door; this is the plumbing under it, which is where
 * the 2026-07-31 defect actually lived. A readline interface was left listening between questions,
 * so a key pressed during a fifteen-second step was echoed as though it had been accepted and was
 * then kept to answer the next question with. That is the same class of failure as feeding a picker
 * positionally: an answer lands on a question nobody meant it for, and every later answer shifts.
 *
 * Ending is tested here too. Raw mode is what makes an arrow key readable and is also what stops
 * the terminal turning Ctrl-C into a signal, so Ctrl-C is this file's job now, both at a question
 * and away from one.
 */

function fakeTty() {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (on: boolean) => void };
  const output = new PassThrough() as PassThrough & { isTTY: boolean };
  input.isTTY = true;
  output.isTTY = true;
  let raw = false;
  input.setRawMode = (on: boolean) => {
    raw = on;
  };
  let written = "";
  output.on("data", (chunk) => {
    written += String(chunk);
  });
  return { input, output, text: () => written, isRaw: () => raw };
}

const OPTIONS = [
  { label: "one", detail: "the first", value: 1 },
  { label: "two", detail: "the second", value: 2 },
  { label: "three", detail: "the third", value: 3 },
];

const ESC = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);

/** Lets the terminal's data handler run before the test looks at what it did. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("driving a menu with the keys", () => {
  it("moves the highlight and returns what enter was on", async () => {
    const tty = fakeTty();
    const terminal = createTerminal({ input: tty.input, output: tty.output });
    const answer = terminal.choose("scenario", OPTIONS);
    await settle();
    tty.input.write(`${ESC}[B`);
    await settle();
    tty.input.write("\r");
    expect(await answer).toBe(2);
    terminal.close();
  });

  it("leaves the answer behind and takes the list away", async () => {
    const tty = fakeTty();
    const terminal = createTerminal({ input: tty.input, output: tty.output });
    const answer = terminal.choose("now what", [
      { label: "continue", detail: "resume the walk from here", value: "continue" },
      { label: "close", detail: "close the app", value: "close" },
    ]);
    await settle();
    const drawn = tty.text().length;
    tty.input.write("\r");
    await answer;

    const after = tty.text().slice(drawn);
    // Erased by counting its own lines back off the screen, so the scrollback holds answers rather
    // than every list they were picked from.
    expect(after).toMatch(new RegExp(`${ESC}\\[\\d+A`));
    expect(after).toContain(`${ESC}[0J`);
    // The acknowledgement that a typed number never gave: at the moment a choice takes effect, the
    // terminal says which one it was, and that is the last thing left on screen.
    expect(after.endsWith("  now what: continue\n")).toBe(true);
    terminal.close();
  });

  it("discards what was typed while it was not asking", async () => {
    // The whole point. A key pressed during a walk must not become the answer to the next question.
    const tty = fakeTty();
    const terminal = createTerminal({ input: tty.input, output: tty.output });
    tty.input.write("3\r");
    await settle();
    expect(tty.text()).toBe("");

    const answer = terminal.choose("scenario", OPTIONS);
    await settle();
    tty.input.write("\r");
    expect(await answer).toBe(1);
    terminal.close();
  });
});

describe("ending a run from the keyboard", () => {
  it("Ctrl-C at a question unwinds instead of ending the process", async () => {
    // So the run closes its app and finishes its run directory like any other ending.
    let exited: number | null = null;
    const tty = fakeTty();
    const terminal = createTerminal({
      input: tty.input,
      output: tty.output,
      exit: (code: number) => {
        exited = code;
      },
    });
    const answer = terminal.choose("scenario", OPTIONS);
    await settle();
    tty.input.write(CTRL_C);
    await expect(answer).rejects.toSatisfy(isTerminalClosed);
    expect(exited).toBeNull();
    terminal.close();
  });

  it("Ctrl-C away from a question stops the app before it stops the driver", async () => {
    // There is nothing to unwind through mid-walk, so the one thing this must still do is not leave
    // a real Obsidian running: the app is launched detached and outlives its parent.
    let stopped = false;
    let exited: number | null = null;
    const tty = fakeTty();
    const terminal = createTerminal({
      input: tty.input,
      output: tty.output,
      onAbort: () => {
        stopped = true;
      },
      exit: (code: number) => {
        exited = code;
      },
    });
    tty.input.write(CTRL_C);
    await settle();
    expect(stopped).toBe(true);
    expect(exited).toBe(130);
    expect(tty.isRaw()).toBe(false);
    terminal.close();
  });

  it("hands the hook back when a run is over, so a later Ctrl-C stops nothing twice", async () => {
    let stopped = 0;
    let exited: number | null = null;
    const tty = fakeTty();
    const terminal = createTerminal({
      input: tty.input,
      output: tty.output,
      onAbort: () => {
        stopped += 1;
      },
      exit: (code: number) => {
        exited = code;
      },
    });
    terminal.onAbort(null);
    tty.input.write(CTRL_C);
    await settle();
    expect(stopped).toBe(0);
    expect(exited).toBe(130);
    terminal.close();
  });
});

describe("a line of typing", () => {
  it("echoes it, and backspace takes it back", async () => {
    const tty = fakeTty();
    const terminal = createTerminal({ input: tty.input, output: tty.output });
    const answer = terminal.line("  label > ");
    await settle();
    tty.input.write("ab");
    await settle();
    tty.input.write(String.fromCharCode(127));
    await settle();
    tty.input.write("c\r");
    expect(await answer).toBe("ac");
    expect(tty.text()).toContain("  label > ");
    terminal.close();
  });
});

describe("the status line", () => {
  it("says what is being waited on, and takes it back when it is over", async () => {
    const tty = fakeTty();
    const terminal = createTerminal({ input: tty.input, output: tty.output });
    terminal.status('waiting for checkpoint "turn-settled"  12s');
    expect(tty.text()).toContain("turn-settled");
    // Cleared rather than scrolled away, so a wait that is over leaves nothing behind. It is one
    // line rewritten in place: a step that has stopped arriving must be visible while it happens
    // and absent afterwards, or the transcript fills with the driver talking about itself.
    const drawn = tty.text().length;
    terminal.status(null);
    expect(tty.text().slice(drawn)).toBe(`\r${ESC}[2K`);
    terminal.say("  wrote the run directory");
    expect(tty.text().endsWith("  wrote the run directory\n")).toBe(true);
    terminal.close();
  });
});

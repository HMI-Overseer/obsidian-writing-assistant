import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
// @ts-expect-error the driver is plain ESM outside the typechecked source tree (plan D6).
import { createTerminal, isTerminalClosed } from "../../../dev/driver/lib/picker.mjs";

/**
 * The picker under a pipe (RFC-0013 plan section 4.1, the non-terminal fallback).
 *
 * The interactive terminal discards anything typed while it is not asking, and its test next door
 * pins that. A pipe is the opposite case and needs the opposite rule: its whole content is answers,
 * and it delivers them in one chunk, so every answer after the first arrives while the driver is
 * still loading and printing the menu the first one chose. The 2026-09-06 defect was exactly that:
 * `printf '2\n11\n1\n' |` chose a mode, then died at the scenario question as though the terminal
 * had closed, because readline's `question()` hears only the next line and the second had already
 * gone by.
 */

function fakePipe() {
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  const output = new PassThrough() as PassThrough & { isTTY: boolean };
  input.isTTY = false;
  output.isTTY = false;
  let written = "";
  output.on("data", (chunk) => {
    written += String(chunk);
  });
  return { input, output, text: () => written };
}

const OPTIONS = [
  { label: "one", detail: "the first", value: 1 },
  { label: "two", detail: "the second", value: 2 },
  { label: "three", detail: "the third", value: 3 },
];

/** Lets readline split the chunk into lines before the test asks for one. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("answers piped in ahead of the questions", () => {
  it("hands each held line to the question that asks for it, in order", async () => {
    const pipe = fakePipe();
    const terminal = createTerminal({ input: pipe.input, output: pipe.output });
    // One chunk, three answers, before any question exists.
    pipe.input.write("2\n3\n1\n");
    await settle();

    expect(await terminal.choose("mode", OPTIONS)).toBe(2);
    expect(await terminal.choose("scenario", OPTIONS)).toBe(3);
    expect(await terminal.choose("theme", OPTIONS)).toBe(1);
    terminal.close();
  });

  it("still answers from held lines after the pipe has ended", async () => {
    const pipe = fakePipe();
    const terminal = createTerminal({ input: pipe.input, output: pipe.output });
    pipe.input.end("2\n3\n");
    await settle();

    expect(await terminal.choose("mode", OPTIONS)).toBe(2);
    expect(await terminal.choose("scenario", OPTIONS)).toBe(3);
    // Nothing held and nothing coming: that is the closed terminal, and it must still say so.
    await expect(terminal.choose("theme", OPTIONS)).rejects.toSatisfy(isTerminalClosed);
  });

  it("waits for a line that has not arrived yet", async () => {
    const pipe = fakePipe();
    const terminal = createTerminal({ input: pipe.input, output: pipe.output });
    const answer = terminal.choose("mode", OPTIONS);
    await settle();
    pipe.input.write("3\n");
    expect(await answer).toBe(3);
    terminal.close();
  });
});

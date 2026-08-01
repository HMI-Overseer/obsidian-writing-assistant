import { describe, expect, it } from "vitest";
// @ts-expect-error the driver is plain ESM outside the typechecked source tree (plan D6).
import { applyKey, chosenLine, decodeKeys, menuLines, viewport } from "../../../dev/driver/lib/menu.mjs";

/**
 * The picker's menu (RFC-0013 plan section 4.1).
 *
 * Two failures from the 2026-07-31 session are what this covers, and both are about what a terminal
 * tells you rather than about what it does. A number typed at a prompt leaves no acknowledgement,
 * so "did that work" goes unanswered, and a key pressed while the driver was not asking was echoed
 * as though it had been. The parts with edges are pure and are tested here: escape sequences
 * arriving several to a chunk, a digit that could be the start of a longer number, and a list
 * taller than the window.
 */

const ESC = String.fromCharCode(27);

function options(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    label: `entry-${index + 1}`,
    detail: `detail ${index + 1}`,
    value: index + 1,
  }));
}

describe("what a chunk of raw stdin means", () => {
  it("reads both encodings of an arrow", () => {
    expect(decodeKeys(`${ESC}[A`)).toStrictEqual(["up"]);
    expect(decodeKeys(`${ESC}OA`)).toStrictEqual(["up"]);
    expect(decodeKeys(`${ESC}[B`)).toStrictEqual(["down"]);
    expect(decodeKeys(`${ESC}OB`)).toStrictEqual(["down"]);
  });

  it("reads every keypress in one chunk, not just the first", () => {
    // A held arrow key, fast typing, and a paste all arrive this way. Dropping the rest is how a
    // menu appears to ignore input.
    expect(decodeKeys(`${ESC}[B${ESC}[B${ESC}[B`)).toStrictEqual(["down", "down", "down"]);
    expect(decodeKeys(`${ESC}[B\r`)).toStrictEqual(["down", "enter"]);
  });

  it("swallows an escape sequence it has no meaning for, whole", () => {
    // Otherwise "\x1b[Z" arrives as a stray "Z" and, worse, "\x1b[3~" arrives as a "3" that jumps
    // the highlight to an entry nobody pointed at.
    expect(decodeKeys(`${ESC}[Z`)).toStrictEqual(["ignore"]);
    expect(decodeKeys(`${ESC}[3~`)).toStrictEqual(["ignore"]);
    expect(decodeKeys(`${ESC}[3~\r`)).toStrictEqual(["ignore", "enter"]);
  });

  it("takes wasd and vi keys as well as arrows, and digits as themselves", () => {
    expect(decodeKeys("wsjk")).toStrictEqual(["up", "down", "down", "up"]);
    expect(decodeKeys("12")).toStrictEqual(["1", "2"]);
  });

  it("calls Ctrl-C and Ctrl-D an abort", () => {
    // Raw mode is what makes the menu possible and is also what stops the terminal turning Ctrl-C
    // into a signal, so a menu that did not decode it would take Ctrl-C away from the maintainer.
    expect(decodeKeys(String.fromCharCode(3))).toStrictEqual(["abort"]);
    expect(decodeKeys(String.fromCharCode(4))).toStrictEqual(["abort"]);
  });
});

describe("where a key leaves the highlight", () => {
  const move = (keys: string[], count: number) =>
    keys.reduce((state, key) => applyKey(state, key, count), { index: 0, digits: "" });

  it("wraps at both ends", () => {
    expect(move(["up"], 5).index).toBe(4);
    expect(move(["down", "down", "down", "down", "down"], 5).index).toBe(0);
  });

  it("jumps to a single digit and then extends it, with no timer deciding which", () => {
    // In a list of fifteen, "1" is entry 1 until a second digit makes it 11. The highlight moves on
    // the first digit and moves again if the next one extends it, so what a number means is always
    // visible before enter commits it.
    expect(move(["1"], 15).index).toBe(0);
    expect(move(["1", "1"], 15).index).toBe(10);
    // "99" is not an entry, so the second 9 is read as a fresh jump to 9 rather than dropped.
    expect(move(["9", "9"], 15).index).toBe(8);
  });

  it("forgets a part-typed number as soon as an arrow moves the highlight", () => {
    expect(move(["1", "down", "1"], 15).index).toBe(0);
  });

  it("ends only on enter or abort", () => {
    expect(move(["down"], 5).done).toBeUndefined();
    expect(move(["enter"], 5).done).toBe("select");
    expect(move(["abort"], 5).done).toBe("abort");
  });
});

describe("the block that gets drawn", () => {
  it("marks the highlighted entry and nothing else", () => {
    const lines: string[] = menuLines({ title: "scenario", options: options(3), index: 1 });
    const rows = lines.filter((line) => line.includes("entry-"));
    expect(rows[1]).toContain("> 2) entry-2");
    expect(rows[0].startsWith("    1)")).toBe(true);
    expect(rows[2].startsWith("    3)")).toBe(true);
  });

  it("keeps group headings, which is what tells live from simulated before you choose", () => {
    const grouped = [
      { label: "a", value: 1, group: "simulated" },
      { label: "b", value: 2, group: "live, real tokens" },
    ];
    const lines: string[] = menuLines({ title: "scenario", options: grouped, index: 0 });
    expect(lines.some((line) => line.trim() === "simulated")).toBe(true);
    expect(lines.some((line) => line.trim() === "live, real tokens")).toBe(true);
  });

  it("never emits a line wider than the window, because a wrapped line breaks the redraw", () => {
    // The block is erased by counting lines back off the screen, so a line the terminal wrapped
    // into two would leave half of the old menu behind on every keypress. The real scenario list
    // is exactly this shape: short labels, and details long enough to run past any window.
    const long = [
      {
        label: "sweep the simulated scenarios",
        detail: "11 runs in series, one directory each, no tokens spent",
        group: "everything at once, and then some words to push this heading past the window too",
        value: 1,
      },
      { label: "abort-mid-turn", detail: "Stop a streaming turn from the composer.", value: 2 },
    ];
    for (const columns of [30, 60]) {
      const lines: string[] = menuLines({ title: "scenario", options: long, index: 0, columns });
      expect(lines.some((line) => line.length > 20)).toBe(true);
      for (const line of lines) expect(line.length).toBeLessThan(columns);
    }
  });

  it("says how many entries are hidden when the list is taller than the window", () => {
    const lines: string[] = menuLines({ title: "scenario", options: options(40), index: 20, rows: 14 });
    expect(lines.join("\n")).toMatch(/more above/);
    expect(lines.join("\n")).toMatch(/more below/);
    expect(lines.length).toBeLessThanOrEqual(14);
  });

  it("keeps the highlighted entry inside the window it draws", () => {
    for (const index of [0, 19, 39]) {
      const lines: string[] = menuLines({ title: "scenario", options: options(40), index, rows: 14 });
      // Right-aligned, so a list running past nine does not shift every label after it by a column.
      expect(lines.join("\n")).toContain(`> ${String(index + 1).padStart(2)}) entry-${index + 1}`);
    }
  });

  it("counts what it hides rather than trimming quietly", () => {
    const entries = Array.from({ length: 10 }, (_, index) => ({ option: index, lines: ["x"] }));
    const view = viewport(entries, 0, 6);
    expect(view.above + (view.end - view.start) + view.below).toBe(10);
  });
});

describe("what the terminal is left with", () => {
  it("records the answer, not the list", () => {
    // The menu is erased and this replaces it. It is also the acknowledgement that was missing: at
    // the moment a choice takes effect, the terminal says which one it was.
    expect(chosenLine("now what", { label: "continue", detail: "resume the walk from here" })).toBe(
      "  now what: continue",
    );
  });
});

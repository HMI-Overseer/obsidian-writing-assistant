// The terminal side of the driver (RFC-0013).
//
// Every choice is a numbered list. Flags exist only to repeat a choice already made, never as
// the way to discover one, which is why there is no `--sandbox`, no `--takeover`, and no
// `--pause`: those are modes, and a mode nobody can find in a list is a mode nobody uses.
//
// `--last` is the one shortcut, because the ergonomic failure of an interactive tool is being
// asked the same three questions on every iteration.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

/** Owns stdin for the whole run: the picker up front, the handover console at the end. */
export function createTerminal() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // A question asked after stdin ends never resolves, so the driver would sit forever holding a
  // launched Obsidian nobody is looking at. Measured, not assumed: `close` fires at the moment a
  // question cannot be satisfied, so racing the two turns Ctrl-D into a plain failure.
  const closed = new Promise((resolve) => rl.once("close", () => resolve(null)));
  const noAnswer = () => new Error("The terminal closed before the driver had an answer.");

  const answer = async (prompt) => {
    let value;
    try {
      value = await Promise.race([rl.question(prompt), closed]);
    } catch (error) {
      // Closing *during* a question resolves the race; asking after it has already closed throws
      // instead. Both mean the same thing to the caller and should read the same way.
      if (error?.code === "ERR_USE_AFTER_CLOSE") throw noAnswer();
      throw error;
    }
    if (value === null) throw noAnswer();
    return value.trim();
  };

  return {
    say(text = "") {
      process.stdout.write(`${text}\n`);
    },

    /**
     * One numbered list, re-asked until the answer is in range.
     *
     * Numbers are right-aligned, because a list that runs past nine otherwise shifts every label
     * after it by a character and stops reading as a column. Options carrying a `group` are
     * printed under a heading when the group changes, so a distinction that matters before you
     * choose (this one spends money, that one is meant to fail) is structural rather than a
     * prefix somebody has to notice inside a description.
     *
     * @param options `{ label, detail, group, value }`, in display order. Grouped options must be
     *   contiguous; nothing re-sorts them, because the display order is the caller's decision.
     * @returns the chosen option's `value`.
     */
    async choose(title, options) {
      if (options.length === 0) throw new Error(`Nothing to choose from for "${title}".`);
      process.stdout.write(`\n  ${title}\n`);
      const width = Math.max(...options.map((option) => option.label.length));
      const numberWidth = String(options.length).length;
      let group = null;
      for (const [index, option] of options.entries()) {
        if (option.group && option.group !== group) {
          group = option.group;
          process.stdout.write(`\n    ${group}\n`);
        }
        const number = String(index + 1).padStart(numberWidth);
        const label = option.label.padEnd(width);
        const detail = option.detail ? `  ${option.detail}` : "";
        process.stdout.write(`    ${number}) ${label}${detail}\n`);
      }
      if (options.length === 1) {
        process.stdout.write(`  > 1\n`);
        return options[0].value;
      }
      for (;;) {
        const index = Number.parseInt(await answer("  > "), 10);
        if (Number.isInteger(index) && index >= 1 && index <= options.length) {
          return options[index - 1].value;
        }
      }
    },

    line(prompt) {
      return answer(prompt);
    },

    close() {
      rl.close();
    },
  };
}

/**
 * The previous run's choices.
 *
 * Kept beside the driver rather than in the run directory, because `out/` is disposable and the
 * point of `--last` is to survive deleting it.
 */
export function readLastChoices(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function writeLastChoices(path, choices) {
  writeFileSync(path, `${JSON.stringify(choices, null, 2)}\n`);
}

/**
 * Every key a stored run carries. The set is the version marker.
 *
 * `live` was added by Stage 3 and is `null` on a scripted run, so its absence is exactly what
 * tells `--last` that a stored file predates live mode.
 */
const STORED_KEYS = ["mode", "scenario", "suite", "fixture", "frames", "theme", "live"];

/**
 * The previous run's choices, but only if this driver still understands them.
 *
 * `--last` repeats a choice already made; it never guesses at one. A stored shape with a key this
 * driver does not know, or missing one it does, is refused outright rather than partially
 * honoured, because the failure mode of the alternative is silent and expensive: the picker skips
 * a question whose answer it thinks it has, and the run walks under a label that is not what it
 * did. That is the same class of failure as feeding a picker positionally, which cost a session's
 * run directories once already.
 *
 * @param modes the mode values this driver ships, so a stored mode it no longer has is refused
 *   here rather than falling through a branch that does not handle it.
 */
export function repeatableChoices(stored, modes) {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return null;
  const keys = Object.keys(stored);
  if (keys.length !== STORED_KEYS.length) return null;
  if (!STORED_KEYS.every((key) => keys.includes(key))) return null;
  if (!modes.includes(stored.mode)) return null;
  return stored;
}

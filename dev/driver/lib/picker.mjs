// The terminal side of the driver (RFC-0013).
//
// Every choice is a list, moved through with the arrow keys and confirmed with enter, still
// numbered so a number still jumps to an entry and so a run can be described in a sentence. Flags
// exist only to repeat a choice already made, never as the way to discover one, which is why there
// is no `--sandbox`, no `--takeover`, and no `--pause`: those are modes, and a mode nobody can find
// in a list is a mode nobody uses.
//
// `--last` is the one shortcut, because the ergonomic failure of an interactive tool is being
// asked the same three questions on every iteration.
//
// This owns stdin for the whole run, and "the whole run" is the part that had to change. It used to
// mean a readline interface left listening between questions, which echoed anything typed during a
// walk and kept it to answer the next question with. Now the driver reads stdin itself: while a
// question is open the keys drive it, and while one is not, everything except Ctrl-C is discarded
// at the moment it arrives rather than buffered into somebody's next answer.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import {
  applyKey,
  chosenLine,
  CLEAR_BELOW,
  CLEAR_LINE,
  cursorUp,
  decodeKeys,
  HIDE_CURSOR,
  menuLines,
  SHOW_CURSOR,
} from "./menu.mjs";

const ESC = String.fromCharCode(27);
const BACKSPACE = [String.fromCharCode(127), String.fromCharCode(8)];
const ABORT = [String.fromCharCode(3), String.fromCharCode(4)];

/**
 * The terminal ended a question without answering it: Ctrl-C, Ctrl-D, or a closed stdin.
 *
 * Named, because callers need to tell it apart from a scenario that failed. A run interrupted at a
 * breakpoint should close its app and finish its run directory like any other ending, and a sweep
 * should stop rather than march on into the next scenario.
 */
export class TerminalClosed extends Error {
  constructor(reason) {
    super(reason);
    this.name = "TerminalClosed";
  }
}

export function isTerminalClosed(error) {
  return error instanceof Error && error.name === "TerminalClosed";
}

/**
 * @param onAbort called before the process is ended by Ctrl-C pressed while nothing is being
 *   asked, which is the only moment there is nothing to unwind through. The app is launched
 *   detached so it survives its parent, so without this a Ctrl-C during a walk leaves a real
 *   Obsidian running on a scratch vault nobody will look at again.
 * @param exit how the process ends, which is a seam rather than a setting: the two Ctrl-C paths
 *   are the part of this file most worth a test and the least testable if ending the run means
 *   ending the test runner.
 */
export function createTerminal({
  input = process.stdin,
  output = process.stdout,
  onAbort = null,
  exit = (code) => process.exit(code),
} = {}) {
  const interactive = Boolean(input.isTTY && output.isTTY);
  return interactive
    ? rawTerminal({ input, output, onAbort, exit })
    : pipedTerminal({ input, output, onAbort });
}

// ─── a terminal somebody is sitting at ──────────────────────────────────────────────────────

function rawTerminal({ input, output, onAbort, exit }) {
  const color = !process.env.NO_COLOR;
  input.setRawMode(true);
  input.setEncoding("utf8");
  input.resume();

  /** Set while a question is open. Everything typed at any other moment is dropped. */
  let reader = null;
  let statusShowing = false;
  let hook = onAbort;

  const stop = () => {
    if (input.isTTY) input.setRawMode(false);
    input.pause();
    // Explicit rather than relied upon. A held stdin keeps the event loop alive, and a driver that
    // finished its work and did not exit would look exactly like the hang all of this is about.
    if (typeof input.unref === "function") input.unref();
    output.write(SHOW_CURSOR);
  };

  const abort = () => {
    // Raw mode is what makes the menu possible and is also what stops the terminal turning Ctrl-C
    // into a signal, so this is not an extra: without it Ctrl-C would do nothing at all.
    stop();
    output.write("\n  stopped.\n");
    if (hook) hook();
    exit(130);
  };

  const clearStatus = () => {
    if (!statusShowing) return;
    output.write(CLEAR_LINE);
    statusShowing = false;
  };

  input.on("data", (chunk) => {
    if (reader) reader(String(chunk));
    else if ([...String(chunk)].some((char) => ABORT.includes(char))) abort();
    // Anything else typed while no question is open is discarded here, deliberately. It is the
    // difference between a key that visibly did nothing and a key that silently becomes the answer
    // to a question asked ten seconds later.
  });

  const ask = (install) =>
    new Promise((settle, fail) => {
      clearStatus();
      reader = install(
        (value) => {
          reader = null;
          settle(value);
        },
        (reason) => {
          reader = null;
          fail(new TerminalClosed(reason));
        },
      );
    });

  const say = (text = "") => {
    clearStatus();
    output.write(`${text}\n`);
  };

  async function menu(title, options) {
    let state = { index: 0, digits: "" };
    let painted = 0;

    const paint = () => {
      clearStatus();
      const lines = menuLines({
        title,
        options,
        index: state.index,
        rows: output.rows,
        columns: output.columns,
        color,
      });
      output.write(`${cursorUp(painted)}${CLEAR_BELOW}${lines.join("\n")}\n`);
      painted = lines.length;
    };

    // Restored before the answer is printed, not after it in a finally, so the last thing written
    // is the line a reader wants: an escape sequence trailing the answer is invisible on a terminal
    // and is noise in anything that reads the output back.
    let hidden = true;
    const showCursor = () => {
      if (!hidden) return;
      output.write(SHOW_CURSOR);
      hidden = false;
    };

    output.write(HIDE_CURSOR);
    try {
      paint();
      const index = await ask((settle, fail) => (chunk) => {
        for (const key of decodeKeys(chunk)) {
          state = applyKey(state, key, options.length);
          if (state.done === "select") return settle(state.index);
          if (state.done === "abort") return fail("Ctrl-C at a question.");
        }
        paint();
      });
      // The block is replaced by the answer, so a session reads as what was chosen rather than as
      // every list it was chosen from.
      output.write(`${cursorUp(painted)}${CLEAR_BELOW}`);
      painted = 0;
      showCursor();
      say(chosenLine(title, options[index], output.columns));
      return options[index].value;
    } finally {
      showCursor();
    }
  }

  return {
    say,

    /** @see menu. `{ label, detail, group, value }`, in display order. */
    async choose(title, options) {
      if (options.length === 0) throw new Error(`Nothing to choose from for "${title}".`);
      if (options.length === 1) {
        say(`  ${title}: ${options[0].label}, the only one offered`);
        return options[0].value;
      }
      return menu(title, options);
    },

    /**
     * A line of typing, echoed as it is typed. Only the shot label asks for one.
     *
     * Deliberately not readline: readline in raw mode owns stdin between questions too, and that
     * ownership is the thing being removed. What is lost is history and word motion, in a prompt
     * whose answer is three words long.
     */
    line(prompt) {
      output.write(prompt);
      let text = "";
      return ask((settle, fail) => (chunk) => {
        if (chunk.startsWith(ESC)) return; // an arrow or a function key, in a field with no cursor
        for (const char of chunk) {
          if (ABORT.includes(char)) return fail("Ctrl-C at a question.");
          if (char === "\r" || char === "\n") {
            output.write("\n");
            return settle(text.trim());
          }
          if (BACKSPACE.includes(char)) {
            if (text.length > 0) {
              text = text.slice(0, -1);
              output.write("\b \b");
            }
            continue;
          }
          if (char >= " ") {
            text += char;
            output.write(char);
          }
        }
      });
    },

    /**
     * One line, rewritten in place, saying what the driver is waiting on.
     *
     * The complaint it answers: a click that misses waits fifteen seconds and a checkpoint that
     * never arrives waits five minutes, and both of those looked exactly like a wedged terminal
     * because nothing was printed until they were over. Nothing here is a wait; it is the wait made
     * visible while it happens.
     */
    status(text) {
      clearStatus();
      if (!text) return;
      const line = `  ${text}`;
      output.write(line.slice(0, Math.max(20, (output.columns ?? 100) - 1)));
      statusShowing = true;
    },

    /** Replaces the hook Ctrl-C runs when no question is open. Null while nothing is launched. */
    onAbort(next) {
      hook = next;
    },

    close() {
      clearStatus();
      stop();
      input.removeAllListeners("data");
    },
  };
}

// ─── stdin that is not a terminal ───────────────────────────────────────────────────────────

/**
 * The fallback: numbered lists read a line at a time.
 *
 * A driver run under a pipe, a CI job, or an editor's terminal that reports no TTY cannot be given
 * a cursor to move, and the honest answer is the prompt this tool has always had rather than a
 * menu that silently accepts nothing.
 */
function pipedTerminal({ input, output, onAbort }) {
  const rl = createInterface({ input, output });
  // A question asked after stdin ends never resolves, so the driver would sit forever holding a
  // launched Obsidian nobody is looking at. Measured, not assumed: `close` fires at the moment a
  // question cannot be satisfied, so racing the two turns Ctrl-D into a plain failure.
  const closed = new Promise((settle) => rl.once("close", () => settle(null)));
  let hook = onAbort;

  const answer = async (prompt) => {
    let value;
    try {
      value = await Promise.race([rl.question(prompt), closed]);
    } catch (error) {
      // Closing *during* a question resolves the race; asking after it has already closed throws
      // instead. Both mean the same thing to the caller and should read the same way.
      if (error?.code === "ERR_USE_AFTER_CLOSE") {
        throw new TerminalClosed("The terminal closed before the driver had an answer.");
      }
      throw error;
    }
    if (value === null) {
      if (hook) hook();
      throw new TerminalClosed("The terminal closed before the driver had an answer.");
    }
    return value.trim();
  };

  return {
    say(text = "") {
      output.write(`${text}\n`);
    },

    async choose(title, options) {
      if (options.length === 0) throw new Error(`Nothing to choose from for "${title}".`);
      output.write(`\n  ${title}\n`);
      const width = Math.max(...options.map((option) => option.label.length));
      const numberWidth = String(options.length).length;
      let group = null;
      for (const [index, option] of options.entries()) {
        if (option.group && option.group !== group) {
          group = option.group;
          output.write(`\n    ${group}\n`);
        }
        const number = String(index + 1).padStart(numberWidth);
        const detail = option.detail ? `  ${option.detail}` : "";
        output.write(`    ${number}) ${option.label.padEnd(width)}${detail}\n`);
      }
      if (options.length === 1) {
        output.write("  > 1\n");
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

    status() {},

    onAbort(next) {
      hook = next;
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

// The picker's menu: keys in, lines out (RFC-0013 plan section 4.1).
//
// Every question was a number typed at a prompt, and the 2026-07-31 session found what that costs.
// A typed answer is one character in a scrollback, so "did that work" is a question the terminal
// genuinely does not answer, and a key pressed while the driver is *not* asking looks exactly like
// one it accepted: a keystroke during a fifteen-second step echoed as `> 4` next to a prompt that
// had already closed, which reads as a hung terminal and is worse than that, because readline was
// holding it to answer the next question with.
//
// The list stays numbered and the numbers still work. What changes is that the highlight moves
// under the arrow keys, so a choice is visible before it is committed, and the block is replaced
// by one line naming what was chosen, so the scrollback records answers rather than menus.
//
// Everything in this file is pure. The stdin plumbing lives in picker.mjs, and the part with the
// interesting edges, escape sequences, digit accumulation, and a list taller than the window, is
// the part that can be tested without a terminal.

const ESC = String.fromCharCode(27);
const CSI = `${ESC}[`;

export const HIDE_CURSOR = `${CSI}?25l`;
export const SHOW_CURSOR = `${CSI}?25h`;
/** Clears from the cursor to the end of the display, which is how a redraw erases the old block. */
export const CLEAR_BELOW = `${CSI}0J`;
/** Back to column zero and clear, which is how the status line is rewritten in place. */
export const CLEAR_LINE = `\r${CSI}2K`;
export const cursorUp = (lines) => (lines > 0 ? `${CSI}${lines}A` : "");

const MARKER = ">";
const HINT = "arrows or wasd to move, a number to jump, enter to choose";
/** The blank line, the title, the hint, and one spare so a full list never scrolls the block. */
const RESERVED_ROWS = 4;
const MIN_VIEWPORT = 8;
const PAGE = 5;

// Both encodings of every arrow: terminals send the application-cursor form after some programs
// leave that mode set, and a menu that only understood one of them would look broken at random.
const SEQUENCES = new Map([
  [`${CSI}A`, "up"],
  [`${ESC}OA`, "up"],
  [`${CSI}B`, "down"],
  [`${ESC}OB`, "down"],
  [`${CSI}C`, "ignore"],
  [`${CSI}D`, "ignore"],
  [`${CSI}H`, "home"],
  [`${ESC}OH`, "home"],
  [`${CSI}1~`, "home"],
  [`${CSI}F`, "end"],
  [`${ESC}OF`, "end"],
  [`${CSI}4~`, "end"],
  [`${CSI}5~`, "pageup"],
  [`${CSI}6~`, "pagedown"],
]);
const SEQUENCE_LENGTHS = [4, 3];

const LETTER_KEYS = new Map([
  ["k", "up"],
  ["w", "up"],
  ["j", "down"],
  ["s", "down"],
]);

const ENTER = ["\r", "\n"];
/** Ctrl-C and Ctrl-D. Both mean the same thing here: the run ends without an answer. */
const ABORT = [String.fromCharCode(3), String.fromCharCode(4)];

/** How much of an unrecognised escape sequence to swallow, so its tail is not read as letters. */
function escapeLength(chunk, at) {
  if (chunk[at + 1] !== "[" && chunk[at + 1] !== "O") return Math.min(2, chunk.length - at);
  let end = at + 2;
  while (end < chunk.length && !(chunk[end] >= "@" && chunk[end] <= "~")) end += 1;
  return Math.min(end + 1, chunk.length) - at;
}

/**
 * One chunk of raw stdin, as a list of key names.
 *
 * A chunk is not a keypress. Held keys, fast typing, and a paste all arrive as several sequences in
 * one read, and dropping the ones after the first is how a menu appears to ignore input.
 */
export function decodeKeys(chunk) {
  const keys = [];
  let at = 0;
  while (at < chunk.length) {
    const char = chunk[at];
    if (char === ESC) {
      const known = SEQUENCE_LENGTHS.map((length) => chunk.slice(at, at + length)).find((text) =>
        SEQUENCES.has(text),
      );
      if (known) {
        keys.push(SEQUENCES.get(known));
        at += known.length;
      } else {
        // Skipped whole rather than read as the characters it happens to contain, which is how
        // "\x1b[Z" would otherwise arrive as a stray "Z".
        at += escapeLength(chunk, at);
        keys.push("ignore");
      }
      continue;
    }
    at += 1;
    if (ENTER.includes(char)) keys.push("enter");
    else if (ABORT.includes(char)) keys.push("abort");
    else if (char >= "0" && char <= "9") keys.push(char);
    else if (LETTER_KEYS.has(char.toLowerCase())) keys.push(LETTER_KEYS.get(char.toLowerCase()));
    else keys.push("ignore");
  }
  return keys;
}

/**
 * Typing a number, without a timer deciding what it meant.
 *
 * In a list of fifteen, "1" is entry 1 until a second digit makes it 11. The highlight moves on the
 * first digit and moves again if the next one extends it to something that exists, so the reading
 * is always visible before enter commits it, and nothing depends on how fast anyone types.
 */
function jump(state, digit, count) {
  for (const candidate of [state.digits + digit, digit]) {
    const value = Number.parseInt(candidate, 10);
    if (Number.isInteger(value) && value >= 1 && value <= count) {
      return { index: value - 1, digits: candidate };
    }
  }
  return state;
}

/** @returns the next `{ index, digits }`, carrying `done` once the menu is over. */
export function applyKey(state, key, count) {
  const move = (next) => ({ index: (next + count) % count, digits: "" });
  switch (key) {
    case "up":
      return move(state.index - 1);
    case "down":
      return move(state.index + 1);
    case "home":
      return { index: 0, digits: "" };
    case "end":
      return { index: count - 1, digits: "" };
    case "pageup":
      return { index: Math.max(0, state.index - PAGE), digits: "" };
    case "pagedown":
      return { index: Math.min(count - 1, state.index + PAGE), digits: "" };
    case "enter":
      return { ...state, done: "select" };
    case "abort":
      return { ...state, done: "abort" };
    default:
      return key >= "0" && key <= "9" ? jump(state, key, count) : state;
  }
}

function bold(text, color) {
  return color ? `${CSI}1m${text}${CSI}0m` : text;
}

function dim(text, color) {
  return color ? `${CSI}2m${text}${CSI}0m` : text;
}

/**
 * Truncates to the window, because a wrapped line is two lines and the redraw counts lines.
 *
 * One column is left spare: a line that reaches the last cell makes some terminals wrap anyway.
 */
function fit(text, columns) {
  const limit = Math.max(20, columns - 1);
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

/**
 * The slice of a too-long list to show, with the selection inside it.
 *
 * Windowing rather than falling back to a plain prompt, because the list this happens to first is
 * the scenario list, which is the one that most needs to be readable. What is hidden is counted and
 * said out loud; a list that quietly showed ten of fifteen would be the same silent cap the
 * instrument refuses everywhere else.
 */
export function viewport(entries, index, budget) {
  const height = (from, to) =>
    entries.slice(from, to).reduce((total, entry) => total + entry.lines.length, 0);
  if (height(0, entries.length) <= budget) {
    return { start: 0, end: entries.length, above: 0, below: 0 };
  }

  const selected = entries.findIndex((entry) => entry.option === index);
  let start = selected;
  let end = selected + 1;
  // Two lines are held back for the markers, so the count of what is hidden always has somewhere
  // to be printed.
  let used = entries[selected].lines.length + 2;
  for (;;) {
    let grew = false;
    if (end < entries.length && used + entries[end].lines.length <= budget) {
      used += entries[end].lines.length;
      end += 1;
      grew = true;
    }
    if (start > 0 && used + entries[start - 1].lines.length <= budget) {
      start -= 1;
      used += entries[start].lines.length;
      grew = true;
    }
    if (!grew) break;
  }

  const options = (from, to) =>
    entries.slice(from, to).filter((entry) => entry.option !== null).length;
  return { start, end, above: options(0, start), below: options(end, entries.length) };
}

/**
 * The whole block, as lines, ready to be written and later counted back off the screen.
 *
 * Numbers stay right-aligned and groups keep their headings, for the reasons they were given in the
 * first place: a list running past nine otherwise shifts every label after it by a column, and a
 * distinction that matters before you choose (this one spends money, that one is meant to fail)
 * belongs in the structure rather than inside a description somebody has to notice.
 */
export function menuLines({ title, options, index, rows = 24, columns = 100, color = false }) {
  const numberWidth = String(options.length).length;
  const labelWidth = Math.max(...options.map((option) => option.label.length));
  const entries = [];
  let group = null;
  for (const [position, option] of options.entries()) {
    if (option.group && option.group !== group) {
      group = option.group;
      entries.push({ option: null, lines: ["", dim(fit(`    ${group}`, columns), color)] });
    }
    const selected = position === index;
    const number = String(position + 1).padStart(numberWidth);
    const detail = option.detail ? `  ${option.detail}` : "";
    const text = fit(
      `  ${selected ? MARKER : " "} ${number}) ${option.label.padEnd(labelWidth)}${detail}`.trimEnd(),
      columns,
    );
    entries.push({ option: position, lines: [selected ? bold(text, color) : text] });
  }

  const view = viewport(entries, index, Math.max(MIN_VIEWPORT, rows - RESERVED_ROWS));
  const lines = ["", fit(`  ${title}`, columns)];
  // Dropped whole in a window too narrow for it, rather than truncated into half a sentence. Every
  // line here is counted back off the screen to erase the block, so one the terminal wrapped would
  // leave the previous draw behind on every keypress.
  if (HINT.length + 2 < columns) lines.push(dim(`  ${HINT}`, color));
  if (view.above > 0) lines.push(dim(`      ${view.above} more above`, color));
  for (const entry of entries.slice(view.start, view.end)) lines.push(...entry.lines);
  if (view.below > 0) lines.push(dim(`      ${view.below} more below`, color));
  return lines;
}

/**
 * What the menu leaves behind once it is over.
 *
 * The block is erased and this replaces it, so a session's scrollback is the answers rather than
 * every list they were picked from. It is also the acknowledgement that was missing: the moment a
 * choice takes effect, the terminal says which one it was.
 */
export function chosenLine(title, option, columns = 100) {
  return fit(`  ${title}: ${option.label}`, columns);
}

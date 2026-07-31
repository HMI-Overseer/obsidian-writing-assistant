// What a scenario is handed, and what the handover console drives too (RFC-0013).
//
// The division of labour is a rule, not a preference:
//
//   Drive through the real UI. Observe and set up through the bridge.
//
// So everything that acts here goes through real keys and clicks against real DOM, and
// everything that reads goes through the bridge's structured state. `ChatView.seedPrompt` exists
// and is tempting; it is not used, because a scenario that seeds the composer through a method
// is not exercising the composer (plan decision D5).
//
// Every call lands in the run's ledger, and a call that fails lands in it as a failure before
// the error is rethrown. That is the whole of plan section 4.3: a click that missed and a
// checkpoint that never arrived both stop the run, both stay on disk, and both draw as a red gap
// rather than being omitted from a sheet that would then read as complete.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  awaitCheckpoint as awaitBridgeCheckpoint,
  CHECKPOINT_TIMEOUT_MS,
  readBaseline,
  readState,
} from "./bridge.mjs";

/** Ceiling on an element that never appears. Not a duration anything waits out. */
const ACTION_TIMEOUT_MS = 15_000;

// ─── the selectors scenarios bind to ────────────────────────────────────────────────────────
//
// In one place, because binding to class names is this instrument's recurring cost and paying it
// once per name beats paying it once per scenario. Every one below was read from `src/` rather
// than recalled: RFC-0013's own example scenario clicked `.lmsa-approval-form-decision` to choose
// a decision, and that class is on the `<fieldset>` wrapping all three choices, not on any
// control. Clicking it would have landed wherever the fieldset's centre happened to be.
//
// The three option selectors reach for the radio input's id suffix, which
// `ApprovalForm`/`AskQuestionForm` compose as `${formId}-${choice}` and
// `${formId}-q${n}-o${n}`. That is a narrower coupling than a positional `:nth-match`, which
// would silently pick the wrong choice if the order ever changed, and it fails loudly if the id
// scheme does.

export const COMPOSER_TEXTAREA = ".lmsa-chat-composer-textarea";
export const COMPOSER_SEND = ".lmsa-chat-composer-send-btn";
/** The send button while a turn is in flight: same control, stop affordance. */
export const COMPOSER_STOP = ".lmsa-chat-composer-send-btn.is-stop";
export const CHAT_ROOT = ".lmsa-root";
/** The composer drawer, whichever form is mounted in it. */
export const COMPOSER_DRAWER = ".lmsa-chat-composer-interaction-body";

export const APPROVAL_FORM = ".lmsa-approval-form";
export const APPROVAL_APPROVE = `${APPROVAL_FORM} .lmsa-interaction-option-input[id$="-approve"]`;
export const APPROVAL_APPROVE_SESSION =
  `${APPROVAL_FORM} .lmsa-interaction-option-input[id$="-approve-session"]`;
/** "Other", the decline row, whose selection expands the guidance field. */
export const APPROVAL_DECLINE = `${APPROVAL_FORM} .lmsa-interaction-option-input[id$="-decline"]`;
export const APPROVAL_GUIDANCE = `${APPROVAL_FORM} .lmsa-interaction-other-textarea`;
export const APPROVAL_SUBMIT = ".lmsa-approval-form-submit";

export const ASK_FORM = ".lmsa-ask-form";
export const ASK_SUBMIT = ".lmsa-ask-form-submit";
/** One option of one question, both zero-based, as the form's own ids number them. */
export const askOption = (questionIndex, optionIndex) =>
  `${ASK_FORM} .lmsa-interaction-option-input[id$="-q${questionIndex}-o${optionIndex}"]`;

/** Only rendered on the last assistant message, so it needs no scoping. */
export const REGENERATE = '.lmsa-chat-window-action-btn[data-action="regenerate"]';

// The model selector, which live mode drives at the start of a run. The rail entry is reached by
// its brand-tint class rather than by position, because the rail's contents depend on which
// providers are enabled and a positional match would silently select a different provider. The
// row is reached by the display name the app itself reported, so nothing here invents a label.
export const MODEL_SELECTOR = ".lmsa-chat-header-meta";
export const MODEL_DROPDOWN = ".lmsa-model-dropdown";
export const MODEL_DROPDOWN_SEARCH = `${MODEL_DROPDOWN} .lmsa-model-dropdown-search-input`;
export const modelRailEntry = (provider) =>
  `${MODEL_DROPDOWN} .lmsa-provider-rail-item.lmsa-brand-tint-${provider}:not(.is-disabled)`;
export const modelDropdownRow = (name) =>
  `${MODEL_DROPDOWN} .lmsa-model-dropdown-item:has(.lmsa-model-dropdown-name:text-is("${name}"))`;

function slug(label) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * A failure, as the sheet will show it.
 *
 * Playwright colours its call log, and those escapes survive into a manifest and then into HTML
 * as literal noise around the one thing a reader is trying to see. The escapes are stripped; the
 * text is not touched.
 */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function message(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(ANSI, "");
}

/**
 * @param onBreakpoint pause mode's hook. `shot()` doubles as the breakpoint because the places a
 *   scenario already declares worth looking at are exactly the places worth stopping at.
 */
export function createScenarioApi({ page, record, onBreakpoint }) {
  let index = 0;

  // The state before the last action, which is what the next checkpoint compares against.
  //
  // Two of the shipped checkpoints describe a *change* rather than a condition, so they need a
  // reference point. Sampling it when the wait begins is only right when nothing happens between
  // the action and the wait, and pause mode is where that assumption broke: a breakpoint at a
  // shot taken mid-turn hands the app over, the turn settles while it is being looked at, and a
  // `turn-settled` that sampled afterwards can never fire, so it runs to its ceiling in silence.
  //
  // Capturing it before each action fixes that and is the more honest reading anyway: what a
  // scenario means by "settled" is "settled since I clicked send", not "since I started waiting".
  // A shot deliberately does **not** move it. Observing is not acting, and a breakpoint must not
  // be able to change what the walk around it is comparing against.
  let baseline = null;

  /** Records the attempt either way, then lets a failure stop the run. */
  const step = async (kind, label, act) => {
    baseline = await readBaseline(page);
    try {
      const value = await act();
      record.action(kind, label, true);
      return value;
    } catch (error) {
      record.action(kind, label, false, message(error));
      throw new Error(`Scenario step ${kind} "${label}" failed: ${message(error)}`);
    }
  };

  const shot = async (label, { selector, breakpoint = true } = {}) => {
    index += 1;
    const name = `${String(index).padStart(2, "0")}-${slug(label)}`;
    const target = selector ? await page.$(selector) : page;
    if (target) await target.screenshot({ path: join(record.dir, "shots", `${name}.png`) });
    const state = await readState(page);
    writeFileSync(join(record.dir, "state", `${name}.json`), `${JSON.stringify(state, null, 2)}\n`);
    // The readout travels with the shot rather than only to a file beside it, because
    // RFC-0013 asks each shot to be "paired with its state snapshot" and a reader who has to
    // open a second file to learn what a picture is of will read the picture alone. The
    // transcript is left out: it is the whole conversation, it is written twice already, and
    // the point here is what was true at this moment.
    const { messages: _transcript, ...readout } = state;
    record.shot(label, `shots/${name}.png`, `state/${name}.json`, readout);
    // A shot taken from the handover console must not re-enter the handover console.
    if (breakpoint && onBreakpoint) await onBreakpoint(label);
  };

  const api = {
    page,
    shot,
    state: () => readState(page),

    click: (selector) =>
      step("click", selector, () => page.click(selector, { timeout: ACTION_TIMEOUT_MS })),

    hover: (selector) =>
      step("hover", selector, () => page.hover(selector, { timeout: ACTION_TIMEOUT_MS })),

    /** Real keystrokes into whatever holds focus. The pacing is input fidelity, not a wait. */
    type: (text) => step("type", text, () => page.keyboard.type(text, { delay: 12 })),

    press: (key) => step("press", key, () => page.keyboard.press(key)),

    /** Click into the composer, type, and send, all as real input. */
    async send(text) {
      await api.click(COMPOSER_TEXTAREA);
      await api.type(text);
      await api.click(COMPOSER_SEND);
    },

    /**
     * Reloads the renderer, and gets back to an open chat view.
     *
     * This is the closest this instrument gets to the application dying, and it is deliberately
     * not sold as more than that. RFC-0011's live walk asks for Obsidian to be killed from the
     * task manager with a write review open, so that orphan recovery has something to recover.
     * A renderer reload destroys the same thing a kill destroys, every scrap of in-memory turn
     * state, and reloads the plugin from disk, which is the input recovery reads. What it does
     * not exercise is the main process dying, and a scenario that reloads should say so.
     *
     * The bridge survives, because it is installed as an init script for exactly this. What does
     * not survive is the checkpoint engine's sampled counters, so an `interaction-submitted`
     * after a reload needs its own raise first.
     */
    async reload() {
      await step("reload", "the renderer", () => page.reload({ waitUntil: "domcontentloaded" }));
      await api.awaitCheckpoint("plugin-ready");
      await page.evaluate(() => window.__lmsaDriver.openChat());
      await api.awaitCheckpoint("view-open");
    },

    /**
     * Waits for a named checkpoint, and fails the run loudly if it never arrives.
     *
     * The failure is the one assertion RFC-0013 allows itself. Arrival is asserted; correctness
     * is not, which keeps the maintainer as the evaluator while denying the instrument the
     * ability to quietly screenshot the wrong moment under the label of the right one.
     */
    async awaitCheckpoint(name, timeoutMs = CHECKPOINT_TIMEOUT_MS) {
      const started = Date.now();
      try {
        await awaitBridgeCheckpoint(page, name, timeoutMs, baseline);
        record.checkpoint(name, true, { ms: Date.now() - started });
      } catch (error) {
        record.checkpoint(name, false, { ms: Date.now() - started, detail: message(error) });
        throw new Error(`Checkpoint "${name}" never arrived. ${message(error)}`);
      }
    },
  };

  return api;
}

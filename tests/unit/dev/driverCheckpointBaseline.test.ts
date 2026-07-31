import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error the driver is plain ESM outside the typechecked source tree (plan D6).
import { createScenarioApi } from "../../../dev/driver/lib/scenarioApi.mjs";

/**
 * What a checkpoint compares against (RFC-0013 plan decision D4, amended twice).
 *
 * Two of the shipped checkpoints describe a change rather than a condition, so they need a
 * reference point. Stage 1 sampled it when the wait began, which is right only when nothing
 * happens between the action and the wait. Pause mode broke that assumption in the field: a
 * breakpoint at a shot taken mid-turn hands the app over, the turn settles while it is being
 * looked at, and a `turn-settled` sampling its baseline afterwards is asking whether the
 * settlement it can already see differs from itself. It never does, so the run sat silent for the
 * full ceiling. Measured on a real run, `dev/driver/out/20260731-215723-live-tool-turn-...`, whose
 * ledger stops at the shot.
 *
 * So the baseline is taken **before each action** and a shot deliberately does not move it.
 * Observing is not acting, and a breakpoint must not change what the walk around it compares
 * against.
 *
 * The predicates themselves run in the page and are not unit-testable without restructuring a
 * working injection. What is testable, and is what broke, is the threading: which readout reaches
 * the wait. The fake page below runs the bridge's own wrapper functions against a stand-in
 * `window.__lmsaDriver`, so these are the real call paths rather than stand-ins for them.
 */

type Waited = { name: string; baseline: unknown };

function harness() {
  const waited: Waited[] = [];
  // The app's own state, which every action advances. Reading it *before* an action and reading
  // it *after* therefore give different answers, which is the distinction under test: a counter
  // of baseline calls could not tell the two apart, and a mutation that took the baseline after
  // the action survived a first version of this file that used one.
  let world = 0;
  const act = <T>(value: T) => {
    world += 1;
    return Promise.resolve(value);
  };
  const driver = {
    baseline: () => ({ world }),
    awaitCheckpoint: (name: string, _ms: number, baseline: unknown) => {
      waited.push({ name, baseline });
      return Promise.resolve();
    },
    state: () => ({ generating: false, messageCount: 1, turnItems: [], messages: [] }),
  };
  (globalThis as { window?: unknown }).window = { __lmsaDriver: driver };

  const dir = mkdtempSync(join(tmpdir(), "driver-baseline-"));
  mkdirSync(join(dir, "shots"), { recursive: true });
  mkdirSync(join(dir, "state"), { recursive: true });

  const page = {
    evaluate: (fn: (arg: unknown) => unknown, arg: unknown) => Promise.resolve(fn(arg)),
    click: () => act(undefined),
    hover: () => act(undefined),
    keyboard: { type: () => act(undefined), press: () => act(undefined) },
    $: () => Promise.resolve(null),
    screenshot: () => Promise.resolve(),
    reload: () => act(undefined),
  };

  const record = {
    dir,
    action: () => {},
    checkpoint: () => {},
    shot: () => {},
    note: () => {},
  };

  return { waited, page, record };
}

describe("the readout a checkpoint compares against", () => {
  let harnessed: ReturnType<typeof harness>;

  beforeEach(() => {
    harnessed = harness();
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("is the state before the action, not the state when the wait began", async () => {
    const api = createScenarioApi({ ...harnessed, onBreakpoint: null });
    await api.click(".lmsa-chat-composer-send-btn");
    await api.awaitCheckpoint("turn-settled");
    expect(harnessed.waited).toStrictEqual([{ name: "turn-settled", baseline: { world: 0 } }]);
  });

  it("survives a shot, because observing is not acting", async () => {
    // The regression this exists for: in pause mode the shot hands the app over, the turn settles
    // while it is being looked at, and a baseline taken after that can never see the change.
    const api = createScenarioApi({ ...harnessed, onBreakpoint: null });
    await api.click(".lmsa-chat-composer-send-btn");
    await api.shot("the turn, in flight");
    await api.awaitCheckpoint("turn-settled");
    expect(harnessed.waited[0].baseline).toStrictEqual({ world: 0 });
  });

  it("survives a breakpoint that pauses for as long as somebody looks", async () => {
    const api = createScenarioApi({
      ...harnessed,
      onBreakpoint: () => new Promise((resolve) => setTimeout(resolve, 5)),
    });
    await api.click(".lmsa-chat-composer-send-btn");
    await api.shot("the turn, in flight");
    await api.awaitCheckpoint("turn-settled");
    expect(harnessed.waited[0].baseline).toStrictEqual({ world: 0 });
  });

  it("moves to the next action, so a second turn is not measured against the first", async () => {
    const api = createScenarioApi({ ...harnessed, onBreakpoint: null });
    await api.click(".lmsa-chat-composer-send-btn");
    await api.awaitCheckpoint("turn-settled");
    await api.click(".lmsa-chat-composer-send-btn");
    await api.awaitCheckpoint("turn-settled");
    expect(harnessed.waited.map((entry) => entry.baseline)).toStrictEqual([
      { world: 0 },
      { world: 1 },
    ]);
  });

  it("is absent before a scenario has acted, so the page samples one itself", async () => {
    // `plugin-ready` and `view-open` are waited on before anything is clicked, and they are level
    // predicates that need no reference point.
    const api = createScenarioApi({ ...harnessed, onBreakpoint: null });
    await api.awaitCheckpoint("plugin-ready");
    expect(harnessed.waited[0].baseline).toBeNull();
  });

  it("is taken once per action, including the three inside send()", async () => {
    const api = createScenarioApi({ ...harnessed, onBreakpoint: null });
    await api.send("Tighten the opening.");
    await api.awaitCheckpoint("turn-started");
    // Click the composer, type, click send: the last one is what the turn is measured from.
    expect(harnessed.waited[0].baseline).toStrictEqual({ world: 2 });
  });
});

import { describe, expect, it } from "vitest";
// @ts-expect-error the driver is plain ESM outside the typechecked source tree (plan D6).
import { askLiveModel, describeModel, preflight, reachability } from "../../../dev/driver/lib/models.mjs";
// @ts-expect-error same.
import { repeatableChoices } from "../../../dev/driver/lib/picker.mjs";

/**
 * Live mode's two Node-side judgements (RFC-0013 Stage 3).
 *
 * The reachability preflight is the checkpoint-arrival rule applied one step earlier: LM Studio's
 * catalog is a last-seen cache, so a model can be selectable and not loaded, and the failure would
 * otherwise surface mid-walk as a confusing half-run whose real cause is that the model was
 * absent. A preflight that passed everything would turn that into a scenario that reads as a
 * defect in the plugin.
 *
 * `--last` is the other one, and it is load-bearing rather than ergonomic: it is the supported way
 * to drive this instrument without a person, so a stored shape it half-understands would skip a
 * question whose answer it thinks it has.
 *
 * Red-green: every case below was observed failing against code that did the wrong thing first,
 * listed in the run record's test-discipline table.
 */

const LOADED = {
  key: "lmstudio:qwen/qwen3.5-9b",
  name: "qwen3.5 9b",
  modelId: "qwen/qwen3.5-9b",
  provider: "lmstudio",
  state: "loaded",
  contextWindow: 262144,
  trainedForToolUse: true,
  vision: null,
  reasoning: null,
};

const UNLOADED = { ...LOADED, key: "lmstudio:gemma-4-12b", modelId: "gemma-4-12b", name: "gemma 4 12b", state: "unloaded" };
const UNKNOWN = { ...LOADED, key: "lmstudio:ghost", modelId: "ghost", name: "ghost", state: "unknown" };
const CLOUD = {
  key: "claudecode:sonnet",
  name: "Sonnet (Claude Code)",
  modelId: "sonnet",
  provider: "claudecode",
  state: "cloud",
  contextWindow: null,
  trainedForToolUse: null,
  vision: null,
  reasoning: ["low", "high"],
};

describe("the reachability preflight", () => {
  it("passes a loaded local model and a cloud one", () => {
    expect(reachability(LOADED).ok).toBe(true);
    expect(reachability(CLOUD).ok).toBe(true);
  });

  it("refuses a model that is selectable but not loaded, naming what to do about it", () => {
    const check = reachability(UNLOADED);
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/not loaded/);
    expect(check.reason).toContain("gemma-4-12b");
  });

  it("refuses a model discovery never reported, and carries the discovery failure", () => {
    const check = reachability(UNKNOWN, "connect ECONNREFUSED 127.0.0.1:1234");
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/ECONNREFUSED/);
  });

  it("fails the run before the walk when the chosen model has gone", () => {
    expect(() => preflight({ models: [LOADED], discoveryError: null }, "lmstudio:gone")).toThrow(
      /no longer offers lmstudio:gone/,
    );
  });

  it("fails the run before the walk when the chosen model is present and unreachable", () => {
    expect(() =>
      preflight({ models: [UNLOADED], discoveryError: null }, "lmstudio:gemma-4-12b"),
    ).toThrow(/cannot be reached/);
  });

  it("returns what the app currently reports, so a run records what executed", () => {
    expect(preflight({ models: [LOADED, CLOUD], discoveryError: null }, "claudecode:sonnet")).toBe(
      CLOUD,
    );
  });
});

describe("what the model list says about a model", () => {
  it("leads with the state, because that is what decides whether it can run at all", () => {
    expect(describeModel(LOADED)).toBe("loaded, tools, 262k");
    expect(describeModel(UNLOADED)).toMatch(/^not loaded/);
    expect(describeModel(CLOUD)).toBe("cloud, reasoning");
  });

  it("says a model has no tool training rather than staying silent about it", () => {
    expect(describeModel({ ...LOADED, trainedForToolUse: false })).toMatch(/no tool training/);
  });
});

/** A terminal that answers by index, and records what it was shown. */
function scriptedTerminal(answers: number[]) {
  const asked: { title: string; options: { label: string; detail?: string }[] }[] = [];
  let next = 0;
  return {
    asked,
    say() {},
    line: async () => "",
    close() {},
    async choose(title: string, options: { label: string; detail?: string; value: unknown }[]) {
      asked.push({ title, options });
      return options[answers[next++]].value;
    },
  };
}

describe("the model question", () => {
  const offered = { models: [LOADED, UNLOADED, CLOUD], discoveryError: null };

  it("offers a matrix over the models that can be reached, and says what it is leaving out", async () => {
    const terminal = scriptedTerminal([0, 0]);
    const chosen = await askLiveModel(terminal, { models: [LOADED, { ...LOADED, key: "lmstudio:b", modelId: "b" }, UNLOADED], discoveryError: null }, null);
    expect(chosen.matrix).toBe(true);
    expect(chosen.models).toHaveLength(2);
    // Named, never dropped: a model that was not judged must not read as one that did badly.
    expect(chosen.skipped).toHaveLength(1);
    expect(terminal.asked[1].options[0].label).toMatch(/all 2 reachable models from lmstudio/);
    expect(terminal.asked[1].options[0].detail).toMatch(/1 skipped/);
  });

  it("does not offer a matrix over one model, which is a run", async () => {
    const terminal = scriptedTerminal([0, 0]);
    await askLiveModel(terminal, { models: [LOADED, UNLOADED], discoveryError: null }, null);
    expect(terminal.asked[1].options[0].label).toBe(LOADED.modelId);
  });

  it("offers an unreachable model, marked, rather than hiding it", async () => {
    const terminal = scriptedTerminal([0, 1]);
    const chosen = await askLiveModel(terminal, { models: [LOADED, UNLOADED], discoveryError: null }, null);
    expect(chosen.models[0]).toBe(UNLOADED);
    expect(terminal.asked[1].options[1].detail).toMatch(/fails the preflight/);
  });

  it("asks only for the model when the scenario pins a provider", async () => {
    const terminal = scriptedTerminal([0, 0]);
    const chosen = await askLiveModel(terminal, offered, "claudecode");
    expect(chosen.provider).toBe("claudecode");
    expect(terminal.asked[0].options).toHaveLength(1);
    expect(chosen.models[0]).toBe(CLOUD);
  });

  it("fails plainly when the app offers nothing for the provider a scenario needs", async () => {
    const terminal = scriptedTerminal([]);
    await expect(askLiveModel(terminal, offered, "openai")).rejects.toThrow(
      /No selectable models for openai/,
    );
  });
});

describe("--last, and the stored shape it will not guess at", () => {
  const MODES = ["sandbox", "walk", "takeover", "pause", "clean"];
  const STORED = {
    mode: "walk",
    scenario: "live-tool-turn",
    suite: null,
    fixture: "writing-basic",
    frames: null,
    theme: "dark",
    live: { kind: "model", provider: "lmstudio", modelId: "qwen/qwen3.5-9b", key: "lmstudio:qwen/qwen3.5-9b" },
  };

  it("repeats a shape it understands", () => {
    expect(repeatableChoices(STORED, MODES)).toBe(STORED);
  });

  it("refuses a shape from before live mode, rather than running without a model", () => {
    const { live: _live, ...beforeStage3 } = STORED;
    expect(repeatableChoices(beforeStage3, MODES)).toBeNull();
  });

  it("refuses a shape from before the sweep, for the same reason", () => {
    const { suite: _suite, ...beforeSweeps } = STORED;
    expect(repeatableChoices(beforeSweeps, MODES)).toBeNull();
  });

  it("repeats a sweep, which names no single scenario", () => {
    const sweep = { ...STORED, scenario: null, suite: "simulated", fixture: null, live: null };
    expect(repeatableChoices(sweep, MODES)).toBe(sweep);
  });

  it("refuses a shape carrying a key it does not know", () => {
    expect(repeatableChoices({ ...STORED, walk: "prose-turn" }, MODES)).toBeNull();
  });

  it("refuses a mode this driver no longer ships", () => {
    expect(repeatableChoices({ ...STORED, mode: "keep-open" }, MODES)).toBeNull();
  });

  it("refuses nothing at all", () => {
    expect(repeatableChoices(null, MODES)).toBeNull();
    expect(repeatableChoices([STORED], MODES)).toBeNull();
  });
});

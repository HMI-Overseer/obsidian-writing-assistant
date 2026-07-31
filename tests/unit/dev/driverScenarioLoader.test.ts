import { describe, expect, it } from "vitest";
// @ts-expect-error the driver is plain ESM outside the typechecked source tree (plan D6).
import { mergeSettings, validateScenario } from "../../../dev/driver/lib/scenario.mjs";

/**
 * The scenario loader fails on an unknown key rather than ignoring it, for the same reason the
 * frame validator does: a scenario whose `frames` key was typed as `frame` would otherwise run
 * against no script at all and screenshot a composer that never sent anything, which reads as a
 * plausible earlier state. That is the one failure mode RFC-0013 exists to remove.
 *
 * Red-green: each case here was observed failing against a loader that accepted the bad input
 * before it was trusted.
 */

const GOOD = {
  id: "prose-turn",
  description: "Type a prompt, stream one scripted prose turn, settle.",
  vault: "writing-basic",
  theme: "dark" as const,
  provider: { kind: "scripted", frames: "prose-turn" },
  run: async () => {},
};

describe("the scenario shape RFC-0013 specifies", () => {
  it("accepts the committed shape and fills the theme in", () => {
    const { theme, ...rest } = GOOD;
    const scenario = validateScenario(rest, "prose-turn");
    expect(scenario.id).toBe("prose-turn");
    expect(scenario.vault).toBe("writing-basic");
    expect(scenario.provider).toStrictEqual({ kind: "scripted", frames: "prose-turn", only: null });
    expect(scenario.theme).toBe("dark");
    expect(scenario.settings).toBeNull();
    expect(theme).toBe("dark");
  });

  it("rejects an unknown key instead of ignoring it", () => {
    expect(() => validateScenario({ ...GOOD, frame: "prose-turn" }, "prose-turn")).toThrow(
      /unknown key "frame"/,
    );
  });

  it("rejects an id that does not match the file it was loaded from", () => {
    expect(() => validateScenario(GOOD, "prose-turns")).toThrow(/does not match the file/);
  });

  it("rejects a fixture vault nobody committed, before a launch is spent on it", () => {
    expect(() => validateScenario({ ...GOOD, vault: "no-such-vault" }, "prose-turn")).toThrow(
      /has no fixture directory/,
    );
  });

  it("rejects frames with no file, before a launch is spent on it", () => {
    const provider = { kind: "scripted", frames: "no-such-frames" };
    expect(() => validateScenario({ ...GOOD, provider }, "prose-turn")).toThrow(/has no file at/);
  });

  it("requires run to be a function, since a scenario with no walk is not one", () => {
    expect(() => validateScenario({ ...GOOD, run: "click send" }, "prose-turn")).toThrow(
      /run must be a function/,
    );
  });
});

/**
 * Live mode (Stage 3). A live scenario names at most a provider kind, never a model: a committed
 * scenario pinning one rots the day the local lineup changes and then fails for a reason
 * unrelated to the defect it was written to pin.
 */
describe("a live scenario", () => {
  const LIVE = {
    id: "prose-turn",
    description: "A real model.",
    vault: "writing-basic",
    provider: { kind: "live" },
    run: async () => {},
  };

  it("is accepted, and carries no frames", () => {
    const scenario = validateScenario(LIVE, "prose-turn");
    expect(scenario.provider).toStrictEqual({ kind: "live", frames: null, only: null });
  });

  it("keeps a provider it is pinned to, for the walks that are harness-specific", () => {
    const provider = { kind: "live", only: "claudecode" };
    expect(validateScenario({ ...LIVE, provider }, "prose-turn").provider.only).toBe("claudecode");
  });

  it("rejects frames rather than ignoring them, because a live run arms no script", () => {
    const provider = { kind: "live", frames: "prose-turn" };
    expect(() => validateScenario({ ...LIVE, provider }, "prose-turn")).toThrow(
      /a live provider takes no frames/,
    );
  });

  it("rejects a provider it could never pick a model from, before a launch is spent", () => {
    const provider = { kind: "live", only: "claude-code" };
    expect(() => validateScenario({ ...LIVE, provider }, "prose-turn")).toThrow(/must be one of/);
  });

  it("rejects only on a scripted provider, where it would mean nothing", () => {
    const provider = { kind: "scripted", frames: "prose-turn", only: "lmstudio" };
    expect(() => validateScenario({ ...GOOD, provider }, "prose-turn")).toThrow(
      /only applies to a live provider/,
    );
  });

  it("still rejects a kind that is neither", () => {
    expect(() =>
      validateScenario({ ...LIVE, provider: { kind: "replay" } }, "prose-turn"),
    ).toThrow(/must be "scripted" or "live"/);
  });
});

describe("a scenario's settings over the fixture baseline", () => {
  it("merges nested objects so one provider gate can be flipped without restating the map", () => {
    const base = {
      agenticMode: true,
      providerSettings: { anthropic: { enabled: true, apiKey: "x" }, openai: { enabled: false } },
    };
    expect(mergeSettings(base, { providerSettings: { anthropic: { enabled: false } } })).toStrictEqual(
      {
        agenticMode: true,
        providerSettings: { anthropic: { enabled: false, apiKey: "x" }, openai: { enabled: false } },
      },
    );
  });

  it("replaces arrays and scalars, because overriding a list means that list", () => {
    const base = { customModels: { anthropic: [{ modelId: "a" }, { modelId: "b" }] }, posture: "ask" };
    expect(mergeSettings(base, { customModels: { anthropic: [{ modelId: "c" }] }, posture: "auto" }))
      .toStrictEqual({ customModels: { anthropic: [{ modelId: "c" }] }, posture: "auto" });
  });

  it("leaves the baseline alone when a scenario patches nothing", () => {
    const base = { agenticMode: true, nested: { keep: 1 } };
    expect(mergeSettings(base, null)).toStrictEqual(base);
  });
});

/**
 * `mustFail` inverts the driver's one assertion for the two committed self-tests, and it is
 * declared by the scenario rather than inferred from its filename. A sweep reads it to say
 * "failed as designed", and to say the opposite, loudly, on the day one of them starts passing.
 */
describe("a scenario that is meant to fail", () => {
  it("says so, and the shape carries it", () => {
    expect(validateScenario({ ...GOOD, mustFail: true }, "prose-turn").mustFail).toBe(true);
  });

  it("defaults to false, so only the alarms are inverted", () => {
    expect(validateScenario(GOOD, "prose-turn").mustFail).toBe(false);
  });

  it("rejects anything but true, because half a declaration is worse than none", () => {
    expect(() => validateScenario({ ...GOOD, mustFail: false }, "prose-turn")).toThrow(
      /mustFail is true or absent/,
    );
  });
});

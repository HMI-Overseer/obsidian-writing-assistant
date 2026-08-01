import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error the driver is plain ESM outside the typechecked source tree (plan D6).
import { createScenarioApi } from "../../../dev/driver/lib/scenarioApi.mjs";

/**
 * A shot, and when it is allowed to be a breakpoint (RFC-0013 plan section 4.4).
 *
 * Pause mode makes every shot a breakpoint, on the reasoning that the places a scenario already
 * declares worth looking at are the places worth stopping at. There is one kind of moment that
 * breaks: a handover does **not** pause the application, so a turn that is streaming when the
 * console opens has settled by the time anyone continues, and `abort-mid-turn`'s stop then fails
 * for a reason belonging to the instrument rather than to the app. Found by the maintainer, driving
 * a sweep by hand on 2026-08-01: "if I just wait, it will always fail".
 *
 * A parked approval is the opposite and is deliberately not declared. It waits for a person, which
 * is what a handover is.
 */

function fakePage(state: Record<string, unknown> = {}) {
  return {
    async evaluate() {
      return {
        pluginLoaded: true,
        viewOpen: true,
        generating: false,
        messageCount: 0,
        turnItems: [],
        messages: [],
        ...state,
      };
    },
    async $() {
      return null;
    },
    async screenshot() {},
  };
}

function fakeRecord() {
  const dir = mkdtempSync(join(tmpdir(), "driver-shots-"));
  mkdirSync(join(dir, "shots"), { recursive: true });
  mkdirSync(join(dir, "state"), { recursive: true });
  const shots: { label: string; readout: unknown }[] = [];
  return {
    dir,
    shots,
    note() {},
    checkpoint() {},
    action() {},
    file() {},
    lastCheckpoint: () => null,
    shot(label: string, _png: string, statePath: string, readout: unknown) {
      shots.push({ label, readout });
      // Proves the state file was written beside the picture rather than only claimed.
      JSON.parse(readFileSync(join(dir, statePath), "utf8"));
    },
  };
}

describe("when a shot is a breakpoint", () => {
  it("stops at an ordinary one", async () => {
    const stops: string[] = [];
    const api = createScenarioApi({
      page: fakePage(),
      record: fakeRecord(),
      onBreakpoint: async (label: string) => {
        stops.push(label);
      },
    });
    await api.shot("the write review, raised");
    expect(stops).toStrictEqual(["the write review, raised"]);
  });

  it("declines to stop at one whose moment the stopping would destroy, and says what it holds", async () => {
    const notices: (string | null)[] = [];
    const api = createScenarioApi({
      page: fakePage({ generating: true }),
      record: fakeRecord(),
      onBreakpoint: async (_label: string, options: { perishable?: string } = {}) => {
        notices.push(options.perishable ?? null);
      },
    });
    await api.shot("streaming", { perishable: "a turn that is still streaming" });
    expect(notices).toStrictEqual(["a turn that is still streaming"]);
  });

  it("takes the picture and the state either way, because the evidence is not what perishes", async () => {
    const record = fakeRecord();
    const api = createScenarioApi({
      page: fakePage({ generating: true }),
      record,
      onBreakpoint: async () => {},
    });
    await api.shot("streaming", { perishable: "a turn that is still streaming" });
    expect(record.shots).toHaveLength(1);
    expect(record.shots[0].label).toBe("streaming");
  });

  it("never re-enters the console for a shot taken from inside it", async () => {
    const stops: string[] = [];
    const api = createScenarioApi({
      page: fakePage(),
      record: fakeRecord(),
      onBreakpoint: async (label: string) => {
        stops.push(label);
      },
    });
    await api.shot("by hand", { breakpoint: false });
    expect(stops).toStrictEqual([]);
  });
});

describe("a shot that only re-frames the one before it", () => {
  /** Two shots, the second scoped, with control over whether anything changed between them. */
  async function twoShots({ changes }: { changes: boolean }) {
    let world = 0;
    const seen: (string | null)[] = [];
    const page = {
      async evaluate() {
        return { viewOpen: true, generating: false, messageCount: world, turnItems: [] };
      },
      async $() {
        return { async screenshot() {} };
      },
      async screenshot() {},
    };
    const api = createScenarioApi({
      page,
      record: fakeRecord(),
      onBreakpoint: async (_label: string, options: { reframes?: string | null } = {}) => {
        seen.push(options.reframes ?? null);
      },
    });
    await api.shot("the whole window");
    if (changes) world += 1;
    await api.shot("the transcript alone", { selector: ".lmsa-root" });
    return seen;
  }

  it("says which selector it was cropped to when nothing changed", async () => {
    expect(await twoShots({ changes: false })).toStrictEqual([null, ".lmsa-root"]);
  });

  it("says nothing when the state moved, because then it is a new moment", async () => {
    // Both halves are required. A scoped shot after something happened is not a re-framing.
    expect(await twoShots({ changes: true })).toStrictEqual([null, null]);
  });

  it("never calls an unscoped shot a re-framing, however still the state is", async () => {
    // The unscoped ones with an unchanged state are the opposite case: a hover, or a selected
    // radio, which the bridge cannot see and the picture is the only evidence of.
    const seen: (string | null)[] = [];
    const api = createScenarioApi({
      page: fakePage(),
      record: fakeRecord(),
      onBreakpoint: async (_label: string, options: { reframes?: string | null } = {}) => {
        seen.push(options.reframes ?? null);
      },
    });
    await api.shot("an answer chosen, before submit");
    await api.shot("the same again, nothing moved");
    expect(seen).toStrictEqual([null, null]);
  });
});

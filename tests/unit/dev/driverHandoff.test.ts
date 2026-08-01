import { describe, expect, it } from "vitest";
// @ts-expect-error the driver is plain ESM outside the typechecked source tree (plan D6).
import { handOver, perishableNotice } from "../../../dev/driver/lib/handoff.mjs";

/**
 * What a breakpoint tells you before you continue (RFC-0013 plan section 4.4).
 *
 * Both lines here were added because the header was read wrong in practice. A breakpoint inside a
 * sweep looked exactly like a breakpoint inside a single walk, where "close" means something quite
 * different. And continuing into an alarm produced a Playwright error about a button that does not
 * exist and is not supposed to, with nothing on screen saying that failing was the point, so the
 * instrument's own self-test read as a defect in the application.
 */

function terminalSaying(choice: string) {
  const lines: string[] = [];
  const offered: { label: string; detail?: string }[] = [];
  return {
    lines,
    offered,
    say(text = "") {
      lines.push(text);
    },
    async choose(_title: string, options: { label: string; detail?: string; value: string }[]) {
      offered.push(...options);
      return choice;
    },
    async line() {
      return "";
    },
    status() {},
    close() {},
  };
}

const HANDOVER = {
  seeded: { vaultDir: "C:/tmp/vault", profileDir: "C:/tmp/profile", scriptId: "prose-turn" },
  record: { dir: "out/20260801-000000-prose-turn" },
  shot: async () => {},
  snapshot: async () => ({
    generating: false,
    turnStatus: "completed",
    messageCount: 2,
    interactionKind: null,
    viewOpen: true,
    turnItems: [],
  }),
  resumable: true,
  at: 'shot "prompt typed"',
  provider: "scripted, prose-turn",
};

describe("the handover header", () => {
  it("says which run of how many, inside a sweep", async () => {
    const terminal = terminalSaying("continue");
    await handOver({ ...HANDOVER, terminal, sweep: { position: 3, total: 9 } });
    expect(terminal.lines.join("\n")).toContain("scenario 3 of 9");
  });

  it("says nothing about a sweep when there is not one", async () => {
    const terminal = terminalSaying("continue");
    await handOver({ ...HANDOVER, terminal });
    expect(terminal.lines.join("\n")).not.toContain("sweep");
  });

  it("warns that continuing into an alarm is what makes it fail", async () => {
    const terminal = terminalSaying("continue");
    await handOver({ ...HANDOVER, terminal, alarm: true });
    expect(terminal.lines.join("\n")).toContain("meant to fail");
  });

  it("says no such thing about a scenario that is meant to complete", async () => {
    const terminal = terminalSaying("continue");
    await handOver({ ...HANDOVER, terminal });
    expect(terminal.lines.join("\n")).not.toContain("meant to fail");
  });

  it("hands back what was chosen, so a walk resumes or ends as asked", async () => {
    for (const choice of ["continue", "close", "detach"]) {
      const terminal = terminalSaying(choice);
      expect(await handOver({ ...HANDOVER, terminal })).toBe(choice);
    }
  });

  it("warns that a turn in flight will not still be in flight on resume", async () => {
    // A handover does not stop the application. The state resumed into is not the state on screen.
    const terminal = terminalSaying("continue");
    await handOver({
      ...HANDOVER,
      terminal,
      snapshot: async () => ({ ...(await HANDOVER.snapshot()), generating: true }),
    });
    expect(terminal.lines.join("\n")).toContain("a turn is in flight");
    expect(terminal.lines.join("\n")).toContain("will not be in flight when you");
  });

  it("says the opposite for a turn parked on the drawer, because that one waits for you", async () => {
    // The same flag, two situations, and one warning was wrong for the second: an approval gate is
    // waiting for a person, which is exactly what a handover is. Every approval scenario stopped in
    // pause mode was being told its turn would be gone when it resumed, and then it was not.
    const terminal = terminalSaying("continue");
    await handOver({
      ...HANDOVER,
      terminal,
      snapshot: async () => ({
        ...(await HANDOVER.snapshot()),
        generating: true,
        interactionKind: "approval",
      }),
    });
    const said = terminal.lines.join("\n");
    expect(said).toContain("parked on the approval drawer");
    expect(said).toContain("still in flight when you resume");
    expect(said).not.toContain("will not be in flight when you");
  });
});

describe("the breakpoint pause mode declines to take", () => {
  it("names what the moment holds, and where to go to sit in one", () => {
    const lines: string[] = perishableNotice("streaming", "a turn that is still streaming");
    expect(lines.join(" ")).toContain('not stopping at "streaming"');
    expect(lines.join(" ")).toContain("a turn that is still streaming");
    // Not silently skipped, and not a dead end: sandbox mode hands the app over with no walk
    // waiting on the far side of it.
    expect(lines.join(" ")).toContain("sandbox mode");
    expect(lines.join(" ")).toContain("recorded");
  });
});

describe("the two disclosures a breakpoint owes you", () => {
  it("says the app has not moved when the shot only re-frames the last one", async () => {
    // Most scenarios end by shooting the whole window and then the transcript alone. Under pause
    // mode both are breakpoints, so continuing from the first hands back a screen that has not
    // changed, which reads as a driver that ignored the keypress.
    const terminal = terminalSaying("continue");
    await handOver({ ...HANDOVER, terminal, reframes: ".lmsa-root" });
    const said = terminal.lines.join("\n");
    expect(said).toContain("the app has not moved");
    expect(said).toContain(".lmsa-root");
    expect(said).toContain("nothing was clicked between the two");
  });

  it("says nothing of the kind when the moment is a new one", async () => {
    const terminal = terminalSaying("continue");
    await handOver({ ...HANDOVER, terminal });
    expect(terminal.lines.join("\n")).not.toContain("the app has not moved");
  });

  it("says the scenario has ended, and which one continuing opens", async () => {
    const terminal = terminalSaying("continue");
    await handOver({
      ...HANDOVER,
      terminal,
      finished: true,
      sweep: { position: 3, total: 9 },
    });
    expect(terminal.lines.join("\n")).toContain(
      "the scenario has ended. continue closes this run and opens scenario 4 of 9",
    );
  });

  it("does not promise a next scenario at the end of the last one", async () => {
    const terminal = terminalSaying("continue");
    await handOver({
      ...HANDOVER,
      terminal,
      finished: true,
      sweep: { position: 9, total: 9 },
    });
    const said = terminal.lines.join("\n");
    expect(said).toContain("the last of the sweep");
    expect(said).not.toContain("opens scenario 10");
  });

  it("and says only that the run closes when there is no sweep", async () => {
    const terminal = terminalSaying("continue");
    await handOver({ ...HANDOVER, terminal, finished: true });
    const said = terminal.lines.join("\n");
    expect(said).toContain("the scenario has ended. continue closes this run.");
    expect(said).not.toContain("scenario 2");
  });
});

describe("what continuing is offered as", () => {
  it("resuming the walk, in the middle of one", async () => {
    const terminal = terminalSaying("continue");
    await handOver({ ...HANDOVER, terminal });
    expect(terminal.offered[0]).toMatchObject({ label: "continue", detail: "resume the walk from here" });
  });

  it("closing the run, at the end of one, because there is no walk left to resume", async () => {
    const terminal = terminalSaying("continue");
    await handOver({ ...HANDOVER, terminal, finished: true });
    expect(terminal.offered[0].detail).toBe("the walk is over: close this run and go on");
  });
});

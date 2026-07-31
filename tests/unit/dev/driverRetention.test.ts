import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error the driver is plain ESM outside the typechecked source tree (plan D6).
import { listRunDirectories, runClean } from "../../../dev/driver/lib/clean.mjs";

/**
 * Retention, and the one distinction it was missing (RFC-0013 unresolved question 3, D13).
 *
 * A scripted run can be produced again in twenty seconds for nothing. A live run cannot be
 * produced again at all: RFC-0013's words are that its artifacts "are worth keeping precisely
 * because the run cannot be recreated". The clean mode offered both under one "keep the 5 newest",
 * and on 2026-07-31 that swept away the artifact discharging RFC-0011's live gate along with
 * eleven scripted runs that cost nothing to redo.
 *
 * So they are two questions now, and for the one that cannot be undone the safe answer is the
 * first entry rather than the last. Red-green: observed failing against the single-question
 * version, and against one that ordered the live question like the cheap one.
 */

function outDir(runs: { name: string; repeatable?: boolean; manifest?: boolean }[]) {
  const dir = mkdtempSync(join(tmpdir(), "driver-retention-"));
  for (const run of runs) {
    mkdirSync(join(dir, run.name), { recursive: true });
    if (run.manifest !== false) {
      writeFileSync(
        join(dir, run.name, "manifest.json"),
        JSON.stringify({ scenario: run.name, repeatable: run.repeatable ?? true }),
      );
    }
  }
  return dir;
}

/** Answers each question by the label it wants, and records what it was offered. */
function terminalChoosing(byLabel: Record<string, string>) {
  const asked: { title: string; labels: string[] }[] = [];
  return {
    asked,
    say() {},
    line: async () => "",
    close() {},
    async choose(title: string, options: { label: string; value: unknown }[]) {
      asked.push({ title, labels: options.map((option) => option.label) });
      const wanted = byLabel[title] ?? "keep everything";
      const found = options.find((option) => option.label.startsWith(wanted));
      return (found ?? options[options.length - 1]).value;
    },
  };
}

describe("what the clean mode knows about a run before it removes it", () => {
  it("reads repeatability from the run's own manifest", () => {
    const dir = outDir([
      { name: "a-scripted", repeatable: true },
      { name: "b-live", repeatable: false },
    ]);
    const runs = listRunDirectories(dir);
    expect(runs.find((run) => run.name === "a-scripted").repeatable).toBe(true);
    expect(runs.find((run) => run.name === "b-live").repeatable).toBe(false);
  });

  it("treats a run it cannot read as unrepeatable, because that is the safe reading", () => {
    // It costs a second question to keep something cheap, and it costs the thing itself to remove
    // something that was not. Every run directory written before Stage 3 lands here.
    const dir = outDir([{ name: "c-broken", manifest: false }]);
    expect(listRunDirectories(dir)[0].repeatable).toBe(false);
  });
});

describe("the clean mode's two questions", () => {
  it("asks about live runs separately, and says why", async () => {
    const dir = outDir([
      { name: "a-scripted", repeatable: true },
      { name: "b-live", repeatable: false },
    ]);
    const terminal = terminalChoosing({});
    await runClean(terminal, dir);
    const titles = terminal.asked.map((entry) => entry.title);
    expect(titles).toContain("run directories, repeatable");
    expect(titles).toContain("run directories, NOT repeatable");
  });

  it("offers keeping everything first for the runs that cannot be produced again", async () => {
    const dir = outDir([{ name: "b-live", repeatable: false }]);
    const terminal = terminalChoosing({});
    await runClean(terminal, dir);
    const live = terminal.asked.find((entry) => entry.title.includes("NOT repeatable"));
    expect(live?.labels[0]).toBe("keep everything");
  });

  it("still puts keeping everything last where a mistake costs twenty seconds", async () => {
    const dir = outDir([{ name: "a-scripted", repeatable: true }]);
    const terminal = terminalChoosing({});
    await runClean(terminal, dir);
    const scripted = terminal.asked.find((entry) => entry.title === "run directories, repeatable");
    expect(scripted?.labels.at(-1)).toBe("keep everything");
  });

  it("removing every repeatable run leaves the live ones alone", async () => {
    const dir = outDir([
      { name: "a-scripted", repeatable: true },
      { name: "b-live", repeatable: false },
    ]);
    const terminal = terminalChoosing({ "run directories, repeatable": "remove all" });
    await runClean(terminal, dir);
    expect(listRunDirectories(dir).map((run) => run.name)).toStrictEqual(["b-live"]);
  });
});

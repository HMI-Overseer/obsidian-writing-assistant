import { describe, expect, it } from "vitest";
// @ts-expect-error the driver is plain ESM outside the typechecked source tree (plan D6).
import {
  renderMatrixSheet,
  renderRunIndex,
  renderRunSheet,
  renderSuiteSheet,
  suiteVerdict,
} from "../../../dev/driver/lib/sheet.mjs";

/**
 * The one assertion RFC-0013 allows itself is arrival, and the sheet is where it is read:
 *
 *   A checkpoint that does not arrive within its timeout fails the run loudly, marks that
 *   scenario incomplete in the manifest, and the review sheet renders the missing checkpoint as
 *   a red gap rather than omitting it.
 *
 * A sheet that omitted what a run failed to reach would read as complete, which is precisely the
 * 2026-07-26 failure this instrument exists to remove: an instrument displaying the wrong state
 * and being read as confirmation. So both directions are asserted here, and the negative one is
 * the load-bearing half. Without it, a renderer that stamped `is-gap` on everything would pass.
 *
 * Red-green: observed failing against a renderer that skipped unarrived checkpoints, and against
 * one that marked every checkpoint as a gap.
 */

const READ_STEP = {
  type: "tool_call",
  label: "read",
  state: "completed",
  arguments: '{"path":"Chapters/One.md"}',
  result: "# One\n\nThe tower had been dark eleven years.",
};

const READOUT = {
  generating: false,
  turnStatus: "completed",
  messageCount: 2,
  interaction: null,
  turnItems: [{ type: "prose", label: "Here is a tighter opening." }, READ_STEP],
};

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    scenario: "prose-turn",
    description: "Type a prompt, stream one scripted prose turn, settle.",
    mode: "walk",
    vault: "writing-basic",
    theme: "dark",
    provider: { kind: "scripted", frames: "prose-turn" },
    complete: true,
    handDriven: false,
    console: 0,
    turnStatus: "completed",
    messageCount: 2,
    turnItems: READOUT.turnItems,
    checkpoints: [
      { name: "plugin-ready", arrived: true },
      { name: "turn-settled", arrived: true },
    ],
    steps: [
      { n: 1, kind: "checkpoint", label: "plugin-ready", ok: true, ms: 900 },
      {
        n: 2,
        kind: "shot",
        label: "turn settled",
        ok: true,
        shot: "shots/02-turn-settled.png",
        stateFile: "state/02-turn-settled.json",
        readout: READOUT,
        after: "turn-settled",
      },
    ],
    ...overrides,
  };
}

const INCOMPLETE = manifest({
  complete: false,
  checkpoints: [
    { name: "plugin-ready", arrived: true },
    { name: "turn-settled", arrived: false },
  ],
  steps: [
    { n: 1, kind: "checkpoint", label: "plugin-ready", ok: true, ms: 900 },
    { n: 2, kind: "click", label: ".lmsa-chat-composer-send", ok: false, detail: "Timeout 15000ms exceeded." },
    { n: 3, kind: "checkpoint", label: "turn-settled", ok: false, detail: "never arrived" },
  ],
});

describe("the review sheet's treatment of what a run failed to reach", () => {
  it("draws an unarrived checkpoint as a red gap, naming it", () => {
    const html = renderRunSheet(INCOMPLETE);
    expect(html).toContain('<span class="chip is-gap">turn-settled, never arrived</span>');
    expect(html).toContain('<li class="step is-gap">');
    expect(html).toContain("never arrived");
  });

  it("draws an action that never landed as a red gap, carrying the selector it missed", () => {
    const html = renderRunSheet(INCOMPLETE);
    expect(html).toContain('class="missing is-gap"');
    expect(html).toContain(".lmsa-chat-composer-send");
    expect(html).toContain("Timeout 15000ms exceeded.");
  });

  it("says the run is incomplete rather than leaving the reader to notice", () => {
    expect(renderRunSheet(INCOMPLETE)).toContain("Incomplete.");
    expect(renderRunSheet(manifest())).toContain("Complete.");
  });

  it("marks nothing as a gap when everything arrived, so the marker means something", () => {
    // Past the stylesheet, which always carries the rules that draw a gap.
    const body = String(renderRunSheet(manifest())).split("</style>")[1];
    expect(body).not.toContain("is-gap");
  });

  it("keeps a shot beside the checkpoint it followed, so a picture cannot drift from its claim", () => {
    const html = renderRunSheet(manifest());
    expect(html).toContain("<strong>turn settled</strong><span>after turn-settled</span>");
  });
});

/**
 * Stage 2's gate is that the maintainer reaches a verdict without opening Obsidian, and a
 * verdict on a tool step, an approval, or an aborted turn is not reachable from a picture and a
 * checkpoint name. Stage 1 wrote the bridge's readout to a file beside each shot and displayed
 * neither the file nor its contents, which is a pairing only for a reader who already knew to go
 * looking.
 */
describe("what a shot is paired with", () => {
  it("shows the readout taken with the shot, not only the picture", () => {
    const html = renderRunSheet(manifest());
    expect(html).toContain("<dt>generating</dt><dd>no</dd>");
    expect(html).toContain("<dt>turn</dt><dd>completed</dd>");
    expect(html).toContain("<dt>drawer</dt><dd>empty</dd>");
  });

  it("shows a tool step's arguments and its result, which is what a verdict turns on", () => {
    // Beside the shot, not only in the turn panel further up: the question a reader has at a
    // picture of a tool step is what that step did *at that moment*.
    const steps = String(renderRunSheet(manifest())).split("<h2>Steps</h2>")[1];
    expect(steps).toContain("&quot;path&quot;:&quot;Chapters/One.md&quot;");
    expect(steps).toContain("The tower had been dark eleven years.");
  });

  it("links the full readout, so nothing is only summarized", () => {
    expect(renderRunSheet(manifest())).toContain('<a href="state/02-turn-settled.json">');
  });

  it("names what a raised approval is asking to do, not merely that one is raised", () => {
    const html = renderRunSheet(
      manifest({
        steps: [
          {
            n: 1,
            kind: "shot",
            label: "approval raised",
            ok: true,
            shot: "shots/01-approval-raised.png",
            readout: {
              generating: true,
              turnStatus: "streaming",
              messageCount: 2,
              interaction: {
                kind: "approval",
                channel: "vault-op",
                summary: "Create Chapters/Two.md",
                detail: "68 characters",
              },
              turnItems: [],
            },
          },
        ],
      }),
    );
    expect(html).toContain("approval, vault-op: Create Chapters/Two.md: 68 characters");
  });

  it("names the question a raised ask is waiting on", () => {
    const html = renderRunSheet(
      manifest({
        steps: [
          {
            n: 1,
            kind: "shot",
            label: "ask raised",
            ok: true,
            shot: "shots/01-ask-raised.png",
            readout: {
              generating: true,
              turnStatus: "streaming",
              messageCount: 2,
              interaction: {
                kind: "ask",
                questions: [{ header: "Viewpoint", question: "Whose head?", options: ["Mara"] }],
              },
              turnItems: [],
            },
          },
        ],
      }),
    );
    expect(html).toContain("ask: Viewpoint, Whose head?");
  });
});

/** The sheet escapes apostrophes, so a substring count has to count what it actually wrote. */
function escapeForCount(text: string): string {
  return text.replaceAll("'", "&#039;");
}

describe("the turn as the run left it", () => {
  it("says what it settled as, which is the whole claim of an abort scenario", () => {
    const html = renderRunSheet(manifest({ turnStatus: "interrupted" }));
    expect(html).toContain("<h2>The turn, as the run left it</h2>");
    expect(html).toContain("<dt>status</dt><dd>interrupted</dd>");
  });

  it("draws a failed tool step as a gap, in the colour every other gap uses", () => {
    const html = renderRunSheet(
      manifest({
        turnStatus: "failed",
        turnItems: [{ type: "tool_call", label: "write_file", state: "failed", isError: true }],
      }),
    );
    expect(html).toContain('<li class="item is-gap">');
  });

  it("prints a rejection once when it is both the result and the error", () => {
    // A rejected tool call carries the same sentence in both fields, and printing it twice reads
    // as two separate things having gone wrong. Read off a real live run's sheet.
    const rejected = "The user doesn't want to proceed with this tool use.";
    const html = renderRunSheet(
      manifest({
        turnStatus: "interrupted",
        turnItems: [
          {
            type: "tool_call",
            label: "write_file",
            state: "failed",
            isError: true,
            result: rejected,
            error: rejected,
          },
        ],
      }),
    );
    expect(html.split(escapeForCount(rejected)).length - 1).toBe(1);
  });

  it("still prints an error that says something the result does not", () => {
    const html = renderRunSheet(
      manifest({
        turnItems: [
          {
            type: "tool_call",
            label: "write_file",
            state: "failed",
            result: "nothing was written",
            error: "EPERM: operation not permitted",
          },
        ],
      }),
    );
    expect(html).toContain("nothing was written");
    expect(html).toContain("EPERM: operation not permitted");
  });

  it("is absent when the run reached no turn, rather than drawn empty", () => {
    const html = renderRunSheet(manifest({ turnStatus: null, turnItems: [] }));
    expect(html).not.toContain("The turn, as the run left it");
  });
});

describe("console output, which this codebase treats as evidence on sight", () => {
  it("puts the count and the lines above everything else on the sheet", () => {
    const html = renderRunSheet(manifest({ console: 2 }), "[error] boom\n[log] banner");
    expect(html).toContain("<h2>Console, 2 lines</h2>");
    expect(html).toContain("[error] boom");
    expect(html.indexOf("Console, 2 lines")).toBeLessThan(html.indexOf("<h2>Run</h2>"));
    expect(html.indexOf("Console, 2 lines")).toBeLessThan(html.indexOf("<h2>Checkpoints</h2>"));
  });

  it("says plainly that there was none, rather than showing an empty block", () => {
    const html = renderRunSheet(manifest({ console: 0 }), "");
    expect(html).toContain("No renderer console output and no uncaught errors.");
    expect(html).toContain("<h2>Console, 0 lines</h2>");
  });

  it("escapes what the renderer logged, since a run's console is not the sheet's markup", () => {
    const html = renderRunSheet(manifest({ console: 1 }), "[error] <img src=x onerror=1>");
    expect(html).toContain("&lt;img src=x onerror=1&gt;");
    expect(html).not.toContain("<img src=x");
  });
});

describe("the index over retained runs", () => {
  it("counts every failed step as a gap, not only the checkpoints", () => {
    // A click that never landed is a gap in the same sense a checkpoint is, and a row reading
    // "incomplete, 0 gaps" would contradict itself.
    const html = renderRunIndex([{ dir: "20260731-182754-x", ...INCOMPLETE }]);
    expect(html).toContain("incomplete, 2 gaps");
  });

  it("says complete without a gap count when nothing failed", () => {
    const html = renderRunIndex([{ dir: "20260731-182110-x", ...manifest() }]);
    expect(html).toContain(">complete</td>");
    expect(html).not.toContain("gaps");
  });

  it("says what a run can hold, which is its privacy class, in three answers not two", () => {
    // A live run contains real model output even when nobody typed into it, so calling it
    // "scripted" beside a fixture-frame run would understate what is in the directory.
    const html = renderRunIndex([
      { dir: "a", ...manifest({ handDriven: true }) },
      { dir: "b", ...manifest() },
      { dir: "c", ...manifest({ provider: { kind: "live", only: null } }) },
    ]);
    expect(html).toContain("anything typed");
    expect(html).toContain("authored frames");
    expect(html).toContain("real model output");
  });
});

describe("the checkpoints this build cannot observe", () => {
  it("names them on the sheet rather than leaving their absence to be inferred", () => {
    const html = renderRunSheet(
      manifest({
        checkpointRegistry: {
          available: ["turn-settled"],
          unavailable: [{ name: "frame-published", reason: "transient under a level predicate" }],
        },
      }),
    );
    expect(html).toContain("<code>frame-published</code>");
    expect(html).toContain("rather than approximated with a\n      sleep");
  });
});

/**
 * Live mode (Stage 3). A live run's sheet has to say two things a scripted one never does: which
 * model actually executed, with what the app discovered about it, and that the run cannot be
 * recreated. The second is the honest half. A live run's whole value is that it caught a real
 * session, and a sheet implying it could be replayed would misrepresent the one property that
 * separates the two modes.
 */
describe("a live run's sheet", () => {
  const LIVE_MODEL = {
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

  const LIVE = manifest({
    provider: { kind: "live", only: null },
    repeatable: false,
    credentials: "the installed plugin's settings, D:\vault\...\data.json",
    model: LIVE_MODEL,
  });

  it("names the model that executed and what the app discovered about it", () => {
    const html = renderRunSheet(LIVE);
    expect(html).toContain("<dt>model</dt><dd>lmstudio:qwen/qwen3.5-9b</dd>");
    expect(html).toContain("<dt>discovered</dt><dd>loaded, tools, 262k</dd>");
  });

  it("says a live run cannot be recreated, and a scripted one can", () => {
    expect(renderRunSheet(LIVE)).toContain("no, a live run cannot be recreated");
    expect(renderRunSheet(manifest({ repeatable: true }))).toContain("yes, the same frames replay");
  });

  it("says where the credentials came from, never what they were", () => {
    const html = renderRunSheet(LIVE);
    expect(html).toContain("the installed plugin&#039;s settings");
    expect(html).toContain("live, a real provider");
  });

  it("says which provider a scenario is pinned to", () => {
    const pinned = manifest({ provider: { kind: "live", only: "claudecode" }, repeatable: false });
    expect(renderRunSheet(pinned)).toContain("live, pinned to claudecode, a real provider");
  });
});

/**
 * The matrix sheet. RFC-0013 asks for one directory per model plus a sheet above them placing the
 * same checkpoint from every model side by side, and says why: the standing judgements about
 * local models are suspect because each model was seen once under conditions nobody can now
 * reconstruct.
 *
 * The load-bearing assertion here is the skipped column. A model the preflight refused was never
 * judged, and a sheet that omitted it would present "not tried" as "tried and did badly", which
 * is the same class of lie as omitting a checkpoint that never arrived.
 */
describe("the matrix sheet", () => {
  const model = (modelId: string, state = "loaded") => ({
    key: `lmstudio:${modelId}`,
    name: modelId,
    modelId,
    provider: "lmstudio",
    state,
    contextWindow: 32768,
    trainedForToolUse: true,
    vision: null,
    reasoning: null,
  });

  const run = (dir: string, modelId: string, labels: string[], complete = true) => ({
    dir,
    scenario: "live-tool-turn",
    complete,
    console: 0,
    turnStatus: complete ? "completed" : "streaming",
    model: model(modelId),
    steps: labels.map((label, index) => ({
      n: index + 1,
      kind: "shot",
      label,
      ok: true,
      shot: `shots/0${index + 1}-${label.replace(/ /g, "-")}.png`,
      after: "turn-settled",
    })),
  });

  const MATRIX = {
    kind: "matrix",
    scenario: "live-tool-turn",
    description: "A real model, asked to read a note and answer from it.",
    mode: "walk",
    vault: "writing-basic",
    theme: "dark",
    modelProvider: "lmstudio",
    provider: { kind: "live", only: null },
    repeatable: false,
    complete: true,
    startedAt: "2026-07-31T22:00:00.000Z",
    runs: [
      run("20260731-a-qwen", "qwen3.5-9b", ["the model, before the turn", "the turn, settled"]),
      run("20260731-b-gemma", "gemma-4-12b", ["the model, before the turn"], false),
    ],
    skipped: [
      { model: model("magistral-small", "unloaded"), reason: "magistral-small is in LM Studio's catalog but is not loaded." },
    ],
  };

  it("places the same shot from every model side by side, each linked to its own run", () => {
    const html = renderMatrixSheet(MATRIX);
    const section = html.split("<h2>the model, before the turn</h2>")[1];
    expect(section).toContain("../20260731-a-qwen/shots/01-the-model,-before-the-turn.png");
    expect(section).toContain("../20260731-b-gemma/shots/01-the-model,-before-the-turn.png");
  });

  it("gives every column a fraction of the grid, so the comparison is a row", () => {
    // Two runs plus one skipped model is three columns.
    expect(renderMatrixSheet(MATRIX)).toContain("repeat(3, minmax(0, 1fr))");
  });

  it("draws a model that never reached a shot as a gap, rather than dropping the column", () => {
    const section = renderMatrixSheet(MATRIX).split("<h2>the turn, settled</h2>")[1];
    expect(section).toContain('class="missing is-gap"');
    expect(section).toContain("this model never reached &quot;the turn, settled&quot;");
  });

  it("draws a model the preflight refused as a column, naming why it was not judged", () => {
    const html = renderMatrixSheet(MATRIX);
    expect(html).toContain("magistral-small");
    expect(html).toContain("is not loaded");
    expect(html).toContain(">not run</td>");
  });

  it("marks nothing as a gap when every model completed, so the marker means something", () => {
    const clean = { ...MATRIX, runs: [MATRIX.runs[0]], skipped: [] };
    const body = String(renderMatrixSheet(clean)).split("</style>")[1];
    expect(body).not.toContain("is-gap");
  });

  it("says how many models ran and how many were skipped", () => {
    const html = renderMatrixSheet(MATRIX);
    expect(html).toContain("2 models on lmstudio");
    // One model is a model, not "1 models": this sheet is read, and the count is often one.
    expect(renderMatrixSheet({ ...MATRIX, runs: [MATRIX.runs[0]] })).toContain("1 model on");
    expect(html).toContain("1 skipped as unreachable");
  });

  it("appears on the index as a matrix rather than as a run with no steps", () => {
    const html = renderRunIndex([{ dir: "20260731-matrix", ...MATRIX }]);
    expect(html).toContain("2 models, 1 skipped");
    expect(html).toContain("matrix, lmstudio");
    // One model is a model here too. The index row is the line a reader scans first, and with one
    // local model loaded it is the row they will see most often.
    const one = renderRunIndex([{ dir: "d", ...MATRIX, runs: [MATRIX.runs[0]] }]);
    expect(one).toContain("1 model, 1 skipped");
  });

  it("shows the model on the index row of a single live run", () => {
    const live = manifest({
      provider: { kind: "live", only: null },
      model: model("qwen3.5-9b"),
      repeatable: false,
    });
    expect(renderRunIndex([{ dir: "a", ...live }])).toContain("lmstudio:qwen3.5-9b");
  });
});

/**
 * The sweep sheet. One run per scenario, in series, read in one place.
 *
 * Its load-bearing case is the inverted one: the self-tests are in the sweep rather than excluded
 * from it, because a sweep is what gets run after a refactor and that is exactly when "does this
 * instrument still notice a missed click" needs answering. So a scenario declaring `mustFail` and
 * then *completing* is the finding, and has to read as one.
 */
describe("the sweep sheet", () => {
  const run = (scenario: string, complete: boolean, extra: Record<string, unknown> = {}) => ({
    dir: `20260731-2200-${scenario}`,
    scenario,
    complete,
    console: 0,
    turnStatus: complete ? "completed" : null,
    steps: [
      {
        n: 1,
        kind: "shot",
        label: "turn settled",
        ok: true,
        shot: "shots/01-turn-settled.png",
        after: "turn-settled",
      },
      ...(complete ? [] : [{ n: 2, kind: "checkpoint", label: "turn-settled", ok: false }]),
    ],
    ...extra,
  });

  const SUITE = {
    kind: "suite",
    suite: "simulated",
    mode: "walk",
    theme: "dark",
    complete: true,
    startedAt: "2026-07-31T22:00:00.000Z",
    runs: [
      run("prose-turn", true),
      run("approval-approve", false),
      run("_selftest-missed-click", false, { mustFail: true }),
    ],
  };

  it("reads a self-test's failure as the instrument working", () => {
    expect(suiteVerdict(SUITE.runs[2])).toStrictEqual({ ok: true, text: "failed as designed" });
    const html = renderSuiteSheet(SUITE);
    expect(html).toContain("failed as designed");
  });

  it("reads a self-test that passed as the instrument having stopped noticing", () => {
    const passed = { ...SUITE.runs[2], complete: true };
    expect(suiteVerdict(passed).ok).toBe(false);
    const html = renderSuiteSheet({ ...SUITE, runs: [passed] });
    expect(html).toContain("passed, so the instrument has stopped noticing");
    expect(html).toContain('class="is-gap"');
  });

  it("names the scenarios that did not do what they were meant to", () => {
    const html = renderSuiteSheet(SUITE);
    expect(html).toContain("1 did not do what");
    expect(html).toContain("approval-approve");
    // The self-test is not among them: it failed, which is what it is for.
    expect(html).not.toContain("_selftest-missed-click.</span>");
  });

  it("says so plainly when every scenario did what it was meant to", () => {
    const html = renderSuiteSheet({ ...SUITE, runs: [SUITE.runs[0], SUITE.runs[2]] });
    expect(html).toContain("Every scenario did what it was meant to do.");
    const body = String(html).split("</style>")[1];
    expect(body).not.toContain("is-gap");
  });

  it("shows where each scenario ended, linked into its own run directory", () => {
    const html = renderSuiteSheet(SUITE);
    expect(html).toContain("../20260731-2200-prose-turn/shots/01-turn-settled.png");
    expect(html).toContain("../20260731-2200-approval-approve/shots/01-turn-settled.png");
  });

  it("draws a scenario that reached no shot at all as a gap", () => {
    const html = renderSuiteSheet({ ...SUITE, runs: [{ ...run("ask-user", false), steps: [] }] });
    expect(html).toContain("reached no shot");
    expect(html).toContain('class="missing is-gap"');
  });

  it("appears on the index as a sweep, counting only the unexpected", () => {
    const html = renderRunIndex([{ dir: "20260731-2200-sweep-simulated", ...SUITE }]);
    expect(html).toContain("3 scenarios, 1 unexpected");
    expect(html).toContain(">sweep</td>");
  });
});

// The review sheet a run is read from (RFC-0013 section "The run directory", plan section 4.4).
//
// It shares its frame with the visual harness through `dev/lib/contactSheet.mjs` (plan decision
// D10), so the two instruments read as one. What is local to this sheet is what is local to this
// subject: the step ledger, the checkpoint strip, and the console block.
//
// Two rules shape it, and both are the RFC's:
//
//   A checkpoint that did not arrive is drawn as a red gap, never omitted. A sheet that quietly
//   leaves out what it failed to reach reads as complete, which is exactly the failure the
//   visual harness produced on 2026-07-26 and the reason this instrument exists.
//
//   Console output is surfaced at the top with its count and its lines. This codebase forbids
//   console.log and reserves console.error for genuine errors, so any output during a run is
//   evidence. It is displayed, never asserted on.

import {
  escapeHtml,
  figureMarkup,
  missingMarkup,
  sheetDocument,
  sheetResponsiveCss,
  SHEET_CARD_CSS,
  SHEET_FRAME_CSS,
} from "../../lib/contactSheet.mjs";
import { describeModel } from "./models.mjs";

/**
 * This sheet's own subject: facts, the step ledger, and absence.
 *
 * The one literal colour in either instrument is here, and it earns the exception. Everything
 * else uses system colours so it follows the reader's theme, but "this did not arrive" has to be
 * conspicuous rather than tasteful, and no system colour keyword means it.
 */
const RUN_CSS = `    code { color: GrayText; overflow-wrap: anywhere; }
    .panel { border: 1px solid GrayText; border-radius: 8px; margin: 20px 0; padding: 16px; }
    .panel > h2 { font-size: 1.1rem; margin-bottom: 12px; }
    .facts { display: grid; gap: 8px 24px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
    .fact { display: flex; gap: 12px; justify-content: space-between; }
    .fact > dt { color: GrayText; }
    .fact > dd { margin: 0; overflow-wrap: anywhere; text-align: right; }
    .fact.is-wide { display: block; grid-column: 1 / -1; }
    .fact.is-wide > dd { text-align: left; }
    .verdict.is-gap { color: crimson; font-weight: 600; }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; }
    .chip { border: 1px solid GrayText; border-radius: 999px; padding: 4px 12px; }
    .chip.is-gap { border-color: crimson; color: crimson; font-weight: 600; }
    .note { color: GrayText; margin: 12px 0 0; }
    .note code { color: inherit; }
    pre {
      background: ButtonFace;
      border: 1px solid GrayText;
      margin: 0;
      overflow-x: auto;
      padding: 12px;
    }
    .steps { list-style: none; margin: 0; padding: 0; }
    .step { border-top: 1px solid GrayText; padding: 16px 0; }
    .step:first-child { border-top: 0; padding-top: 0; }
    .step > h3 { font-size: 1rem; margin-bottom: 8px; }
    .step > h3 > span { color: GrayText; font-weight: 400; }
    .step.is-gap > h3 { color: crimson; }
    .readout { display: flex; flex-wrap: wrap; gap: 4px 20px; margin: 12px 0 0; }
    .readout > div { display: flex; gap: 8px; }
    .readout dt { color: GrayText; }
    .readout dd { margin: 0; }
    .items { list-style: none; margin: 12px 0 0; padding: 0; }
    .item { border-left: 2px solid GrayText; margin-top: 8px; padding: 2px 0 2px 12px; }
    .item.is-gap { border-left-color: crimson; }
    .item > h4 { font-size: 0.95rem; font-weight: 600; margin: 0 0 4px; }
    .item > h4 > span { color: GrayText; font-weight: 400; }
    .item > pre { font-size: 0.85rem; margin-top: 4px; }
    .item > p { margin: 0; white-space: pre-wrap; }
    .missing.is-gap { border-color: crimson; color: crimson; }
    .missing.is-gap span { color: crimson; }
    /* The shared card styling title-cases its captions, which suits "light" and "baseline" and
       ruins a CSS selector: a sheet reporting .Lmsa-Chat-Composer-Send is lying about the very
       thing it says was missed. */
    .step figcaption, .step .missing { text-transform: none; }
    .runs { border-collapse: collapse; width: 100%; }
    .runs th, .runs td { border-bottom: 1px solid GrayText; padding: 8px 12px; text-align: left; }
    .runs th { color: GrayText; font-weight: 400; }
    .runs td.is-gap { color: crimson; }
    .grid { display: grid; gap: 20px; }
    .grid figcaption, .grid .missing { text-transform: none; }`;

const RESPONSIVE_CSS = sheetResponsiveCss(
  `      .facts { grid-template-columns: 1fr; }
      .grid { grid-template-columns: 1fr; }`,
);

const CSS = [SHEET_FRAME_CSS, RUN_CSS, SHEET_CARD_CSS, RESPONSIVE_CSS].join("\n");

function factMarkup(label, value, wide = false) {
  if (value === null || value === undefined || value === "") return "";
  return `<div class="fact${wide ? " is-wide" : ""}"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(
    value,
  )}</dd></div>`;
}

function shortHash(hash) {
  return typeof hash === "string" ? `${hash.slice(0, 12)}...` : null;
}

/**
 * Which provider produced this run, and whether it can be produced again.
 *
 * A live run is honestly labelled as not repeatable, because that is its whole value: a real
 * session is the thing that could not previously be re-read, and a run directory that implied it
 * could be recreated would be lying about the one property that distinguishes the two modes.
 */
function providerText(manifest) {
  const provider = manifest.provider ?? {};
  if (provider.kind === "scripted") return `scripted, ${provider.frames}`;
  if (provider.kind === "live") {
    const pinned = provider.only ? `, pinned to ${provider.only}` : "";
    return `live${pinned}, a real provider`;
  }
  return "none, the vault's own settings";
}

function factsPanel(manifest) {
  const model = manifest.model ?? null;
  const facts = [
    factMarkup("scenario", manifest.scenario ?? `sandbox, ${manifest.vault}`),
    factMarkup("mode", manifest.mode),
    factMarkup("vault", manifest.vault),
    factMarkup("theme", manifest.theme),
    factMarkup("provider", providerText(manifest)),
    factMarkup("model", model ? model.key : manifest.askedForModel),
    factMarkup("discovered", model ? describeModel(model) : null),
    factMarkup(
      "repeatable",
      manifest.repeatable === false
        ? "no, a live run cannot be recreated"
        : manifest.repeatable === true
          ? "yes, the same frames replay"
          : null,
    ),
    factMarkup("credentials", manifest.credentials),
    factMarkup("hand driven", manifest.handDriven ? "yes, a person typed into this run" : "no"),
    factMarkup("settings patch", manifest.settingsPatch ? "yes" : "the fixture baseline"),
    factMarkup("obsidian", manifest.pinnedAsar),
    factMarkup("engine", manifest.engines?.Browser),
    factMarkup("main.js", shortHash(manifest.artifacts?.["main.js"])),
    factMarkup("styles.css", shortHash(manifest.artifacts?.["styles.css"])),
    factMarkup(
      "installed bundle",
      manifest.epilogue
        ? `release build plus the driver epilogue, ${shortHash(manifest.epilogue.epilogueSha256)}`
        : "the release build, untouched",
    ),
    factMarkup("error", manifest.error, true),
  ].join("\n      ");

  return `<section class="panel">
    <h2>Run</h2>
    <dl class="facts">
      ${facts}
    </dl>
  </section>`;
}

function consolePanel(manifest, consoleText) {
  const count = manifest.console ?? 0;
  const body =
    count === 0
      ? `<p class="note">No renderer console output and no uncaught errors.</p>`
      : `<pre>${escapeHtml(consoleText.trimEnd())}</pre>`;
  return `<section class="panel">
    <h2>Console, ${count} ${count === 1 ? "line" : "lines"}</h2>
    ${body}
  </section>`;
}

function checkpointsPanel(manifest) {
  const checkpoints = manifest.checkpoints ?? [];
  const chips =
    checkpoints.length === 0
      ? `<p class="note">This run waited on no checkpoints.</p>`
      : `<div class="chips">${checkpoints
          .map(
            (checkpoint) =>
              `<span class="chip${checkpoint.arrived ? "" : " is-gap"}">${escapeHtml(
                checkpoint.name,
              )}${checkpoint.arrived ? "" : ", never arrived"}</span>`,
          )
          .join("")}</div>`;

  const unavailable = manifest.checkpointRegistry?.unavailable ?? [];
  const note =
    unavailable.length === 0
      ? ""
      : `<p class="note">Unavailable in this build, recorded rather than approximated with a
      sleep: ${unavailable
        .map((entry) => `<code>${escapeHtml(entry.name)}</code>`)
        .join(", ")}. See the manifest for each reason.</p>`;

  return `<section class="panel">
    <h2>Checkpoints</h2>
    ${chips}
    ${note}
  </section>`;
}

/**
 * One turn item, as the transcript holds it.
 *
 * The verdict Stage 2 is gated on is reached here or not at all. "A tool step happened" is not a
 * verdict; the tool's name, the arguments it ran with, and the result it came back with are.
 * Nothing is clamped, because the whole point is that the reader does not have to open the app,
 * and a fixture turn is short.
 */
function itemMarkup(item) {
  if (item.type === "prose") {
    return `<li class="item">
      <h4>prose</h4>
      <p>${escapeHtml(item.label ?? "")}</p>
    </li>`;
  }
  const failed = item.isError === true || item.state === "failed";
  const detail = [
    item.arguments ? `<pre>${escapeHtml(item.arguments)}</pre>` : "",
    item.result ? `<p>${escapeHtml(item.result)}</p>` : "",
    // A failed tool item usually carries the same sentence as both its result and its error, and
    // printing it twice reads as two separate things having gone wrong.
    item.error && item.error !== item.result ? `<p>${escapeHtml(item.error)}</p>` : "",
  ]
    .filter(Boolean)
    .join("\n      ");
  const askStatus = item.askStatus ? `, ask ${item.askStatus}` : "";
  return `<li class="item${failed ? " is-gap" : ""}">
      <h4>${escapeHtml(item.label ?? "")} <span>${escapeHtml(
        `${item.state ?? ""}${askStatus}`,
      )}</span></h4>
      ${detail}
    </li>`;
}

function itemsMarkup(items) {
  if (!Array.isArray(items) || items.length === 0) return "";
  return `<ol class="items">
      ${items.map(itemMarkup).join("\n      ")}
    </ol>`;
}

/** How the drawer reads at one moment: which lane, and what it is asking about. */
function drawerText(interaction) {
  if (!interaction) return "empty";
  if (interaction.kind === "approval") {
    return [
      `approval, ${interaction.channel ?? "unknown channel"}`,
      interaction.summary,
      interaction.detail,
    ]
      .filter(Boolean)
      .join(": ");
  }
  if (interaction.kind === "ask") {
    const questions = (interaction.questions ?? [])
      .map((question) => `${question.header}, ${question.question}`)
      .join(" / ");
    return questions ? `ask: ${questions}` : "ask";
  }
  return interaction.kind;
}

/**
 * The bridge's readout at the moment a shot was taken.
 *
 * RFC-0013 asks each shot to be "paired with its state snapshot". Stage 1 wrote the snapshot to a
 * file beside the picture and showed neither the file nor its contents, which is a pairing only
 * for a reader who already knew to go looking.
 */
function readoutMarkup(step) {
  const readout = step.readout;
  if (!readout) return "";
  const facts = [
    `<div><dt>generating</dt><dd>${readout.generating ? "yes" : "no"}</dd></div>`,
    `<div><dt>turn</dt><dd>${escapeHtml(readout.turnStatus ?? "none yet")}</dd></div>`,
    `<div><dt>messages</dt><dd>${escapeHtml(String(readout.messageCount ?? 0))}</dd></div>`,
    `<div><dt>drawer</dt><dd>${escapeHtml(drawerText(readout.interaction))}</dd></div>`,
  ].join("\n      ");
  const link = step.stateFile
    ? `<p class="note"><a href="${escapeHtml(step.stateFile)}">${escapeHtml(
        step.stateFile,
      )}</a>, the full readout including the transcript</p>`
    : "";
  return `<dl class="readout">
      ${facts}
    </dl>
    ${itemsMarkup(readout.turnItems)}
    ${link}`;
}

function stepMarkup(step) {
  const heading = `<h3>${escapeHtml(`${step.n}. ${step.kind}`)} <span>${escapeHtml(
    step.label,
  )}</span></h3>`;

  if (!step.ok) {
    return `<li class="step is-gap">
    ${heading}
    ${missingMarkup({
      label: step.kind === "checkpoint" ? "never arrived" : "never happened",
      note: step.detail ?? "",
      tone: "is-gap",
    })}
  </li>`;
  }

  if (step.kind === "shot" && step.shot) {
    return `<li class="step">
    ${heading}
    ${figureMarkup({
      label: step.label,
      meta: step.after ? `after ${step.after}` : "before any checkpoint",
      href: step.shot,
      src: step.shot,
      alt: `${step.label}, after ${step.after ?? "no checkpoint"}`,
    })}
    ${readoutMarkup(step)}
  </li>`;
  }

  const note = step.ms ? `arrived after ${step.ms}ms` : step.detail;
  const body = note ? `\n    <p class="note">${escapeHtml(note)}</p>` : "";
  return `<li class="step">
    ${heading}${body}
  </li>`;
}

/**
 * The turn as it was left, which is what an aborted or failed run is judged on.
 *
 * A checkpoint strip says `turn-settled` arrived. It does not say the turn settled
 * *interrupted*, with its tool step interrupted under it, which is the entire claim of an
 * abort scenario and was previously only in `state.json`.
 */
function turnPanel(manifest) {
  if (!manifest.turnStatus && !(manifest.turnItems ?? []).length) return "";
  return `<section class="panel">
    <h2>The turn, as the run left it</h2>
    <dl class="readout">
      <div><dt>status</dt><dd>${escapeHtml(manifest.turnStatus ?? "none")}</dd></div>
      <div><dt>messages</dt><dd>${escapeHtml(String(manifest.messageCount ?? 0))}</dd></div>
    </dl>
    ${itemsMarkup(manifest.turnItems)}
    <p class="note"><a href="transcript.json">transcript.json</a>, and
    <a href="transcript.canonical.json">transcript.canonical.json</a> with generated identity and
    wall clock removed</p>
  </section>`;
}

function stepsPanel(manifest) {
  const steps = manifest.steps ?? [];
  if (steps.length === 0) {
    return `<section class="panel">
    <h2>Steps</h2>
    <p class="note">Nothing ran.</p>
  </section>`;
  }
  return `<section class="panel">
    <h2>Steps</h2>
    <ol class="steps">
  ${steps.map(stepMarkup).join("\n  ")}
    </ol>
  </section>`;
}

/**
 * One run's review sheet.
 *
 * Written on every manifest flush rather than at the end, so a run that dies at its third step
 * still leaves a sheet that says where it stopped (plan decision D8).
 */
export function renderRunSheet(manifest, consoleText = "") {
  const name = manifest.scenario ?? `sandbox on ${manifest.vault}`;
  // The verdict is the first thing read, so an incomplete run says so in the colour its gaps are
  // drawn in rather than in the same grey as everything else.
  const verdict = manifest.complete
    ? `<span class="verdict">Complete.</span>`
    : `<span class="verdict is-gap">Incomplete. Something it was told to wait for never
      arrived.</span>`;
  return sheetDocument({
    title: `Driver run, ${name}`,
    heading: `Driver run, ${name}`,
    intro: `${escapeHtml(manifest.description ?? "")}
      <br>${verdict} ${escapeHtml(manifest.startedAt ?? "")}`,
    css: CSS,
    body: [
      consolePanel(manifest, consoleText),
      factsPanel(manifest),
      checkpointsPanel(manifest),
      turnPanel(manifest),
      stepsPanel(manifest),
    ]
      .filter(Boolean)
      .join("\n  "),
  });
}

// ─── the matrix sheet ───────────────────────────────────────────────────────────────────────
//
// One column per model, the same checkpoint side by side. RFC-0013 asks for exactly this and says
// why: the standing judgements about local models are suspect because each model was seen once,
// under conditions nobody can now reconstruct, so the same scenario and the same fixture vault
// beside each result is what makes them comparable at all.
//
// A model that was never run is a column, not an omission. "Not judged" and "judged and did
// badly" are different findings and a sheet that dropped the first would present it as the
// second.

/** Every shot label any model reached, in the order the first model that got there reached it. */
function matrixLabels(runs) {
  const labels = [];
  for (const run of runs) {
    for (const step of run.steps ?? []) {
      if (step.kind === "shot" && step.ok && !labels.includes(step.label)) labels.push(step.label);
    }
  }
  return labels;
}

function matrixColumns(matrix) {
  return [
    ...matrix.runs.map((run) => ({ run, model: run.model, skipped: null })),
    ...matrix.skipped.map((entry) => ({ run: null, model: entry.model, skipped: entry.reason })),
  ];
}

function matrixCell(column, label) {
  const name = column.model?.modelId ?? column.model?.key ?? "unknown model";
  if (column.skipped) {
    return missingMarkup({ label: name, note: "not run", tone: "is-gap" });
  }
  const step = (column.run.steps ?? []).find(
    (candidate) => candidate.kind === "shot" && candidate.ok && candidate.label === label,
  );
  if (!step) {
    return missingMarkup({
      label: name,
      note: `this model never reached "${label}"`,
      tone: "is-gap",
    });
  }
  const href = `../${column.run.dir}/${step.shot}`;
  return figureMarkup({
    label: name,
    meta: step.after ? `after ${step.after}` : "before any checkpoint",
    href,
    src: href,
    alt: `${label}, ${name}`,
  });
}

function matrixModelsPanel(matrix) {
  const rows = matrixColumns(matrix)
    .map((column) => {
      const name = column.model?.modelId ?? column.model?.key ?? "";
      if (column.skipped) {
        return `<tr>
        <td>${escapeHtml(name)}</td>
        <td>${escapeHtml(column.model ? describeModel(column.model) : "")}</td>
        <td class="is-gap">not run</td>
        <td class="is-gap" colspan="2">${escapeHtml(column.skipped)}</td>
      </tr>`;
      }
      const run = column.run;
      const missing = (run.steps ?? []).filter((step) => step.ok === false).length;
      return `<tr>
        <td><a href="../${escapeHtml(run.dir)}/index.html">${escapeHtml(name)}</a></td>
        <td>${escapeHtml(column.model ? describeModel(column.model) : "")}</td>
        <td${run.complete ? "" : ' class="is-gap"'}>${
          run.complete ? "complete" : `incomplete, ${missing} gap${missing === 1 ? "" : "s"}`
        }</td>
        <td>${escapeHtml(run.turnStatus ?? "no turn")}</td>
        <td>${escapeHtml(String(run.console ?? 0))}</td>
      </tr>`;
    })
    .join("\n      ");

  return `<section class="panel">
    <h2>Models</h2>
    <table class="runs">
      <tr><th>model</th><th>discovered</th><th>outcome</th><th>turn</th><th>console</th></tr>
      ${rows}
    </table>
  </section>`;
}

/** One matrix run's sheet: the models, then every shot placed across all of them. */
export function renderMatrixSheet(matrix) {
  const columns = matrixColumns(matrix);
  const labels = matrixLabels(matrix.runs ?? []);
  const grid =
    labels.length === 0
      ? `<section class="panel"><h2>Shots</h2><p class="note">No model reached a shot.</p></section>`
      : labels
          .map(
            (label) => `<section class="panel">
    <h2>${escapeHtml(label)}</h2>
    <div class="grid">
      ${columns.map((column) => matrixCell(column, label)).join("\n      ")}
    </div>
  </section>`,
          )
          .join("\n  ");

  const verdict = matrix.complete
    ? `<span class="verdict">Every model that could be reached was run.</span>`
    : `<span class="verdict is-gap">Incomplete. The sweep did not finish.</span>`;

  return sheetDocument({
    title: `Driver matrix, ${matrix.scenario}`,
    heading: `Driver matrix, ${matrix.scenario}`,
    intro: `${escapeHtml(matrix.description ?? "")}
      <br>${escapeHtml(String((matrix.runs ?? []).length))} ${
        (matrix.runs ?? []).length === 1 ? "model" : "models"
      } on ${escapeHtml(matrix.modelProvider ?? "one provider")}, one run each, ${escapeHtml(
        matrix.theme ?? "",
      )} theme. ${escapeHtml(String((matrix.skipped ?? []).length))} skipped as unreachable.
      <br>${verdict} Live runs are not repeatable. ${escapeHtml(matrix.startedAt ?? "")}`,
    css: `${CSS}
    .grid { grid-template-columns: repeat(${Math.max(1, columns.length)}, minmax(0, 1fr)); }`,
    body: [matrixModelsPanel(matrix), grid].join("\n  "),
  });
}

// ─── the suite sheet ────────────────────────────────────────────────────────────────────────
//
// One run per scenario, in series, read in one place. What a matrix does across models this does
// across walks, and the difference in the sheet follows from the difference in the axis: models
// share a shot label so they can be placed side by side, scenarios do not, so what lines up is
// the outcome and the last picture each one reached.
//
// The self-tests are in the sweep rather than excluded from it, with their expectation inverted:
// they exist to fail, so a suite that saw one *complete* is reporting that the instrument has
// stopped noticing. Excluding them would have been the easy way to a green sheet and would have
// left the sweep unable to say anything about its own honesty.

/** How a run should be read, given what its scenario said it was for. */
export function suiteVerdict(run) {
  const gaps = (run.steps ?? []).filter((step) => step.ok === false).length;
  if (run.mustFail === true) {
    return run.complete
      ? { ok: false, text: "passed, so the instrument has stopped noticing" }
      : { ok: true, text: "failed as designed" };
  }
  return run.complete
    ? { ok: true, text: "complete" }
    : { ok: false, text: `incomplete, ${gaps} gap${gaps === 1 ? "" : "s"}` };
}

/** The last picture a run reached, which is the one worth putting in a row of them. */
function lastShot(run) {
  return (run.steps ?? []).filter((step) => step.kind === "shot" && step.ok && step.shot).pop();
}

function suiteRunsPanel(suite) {
  const rows = (suite.runs ?? [])
    .map((run) => {
      const verdict = suiteVerdict(run);
      return `<tr>
        <td><a href="../${escapeHtml(run.dir)}/index.html">${escapeHtml(run.scenario ?? run.dir)}</a></td>
        <td${verdict.ok ? "" : ' class="is-gap"'}>${escapeHtml(verdict.text)}</td>
        <td>${escapeHtml(run.mustFail === true ? "meant to fail" : "meant to complete")}</td>
        <td>${escapeHtml(run.turnStatus ?? "no turn")}</td>
        <td>${escapeHtml(String(run.console ?? 0))}</td>
      </tr>`;
    })
    .join("\n      ");

  return `<section class="panel">
    <h2>Scenarios</h2>
    <table class="runs">
      <tr><th>scenario</th><th>outcome</th><th>expectation</th><th>turn</th><th>console</th></tr>
      ${rows}
    </table>
  </section>`;
}

function suiteShotsPanel(suite) {
  const runs = suite.runs ?? [];
  if (runs.length === 0) return "";
  const cells = runs
    .map((run) => {
      const step = lastShot(run);
      const verdict = suiteVerdict(run);
      if (!step) {
        return missingMarkup({
          label: run.scenario ?? run.dir,
          note: "reached no shot",
          tone: verdict.ok ? "" : "is-gap",
        });
      }
      const href = `../${run.dir}/${step.shot}`;
      return figureMarkup({
        label: run.scenario ?? run.dir,
        meta: step.label,
        href,
        src: href,
        alt: `${run.scenario}, ${step.label}`,
      });
    })
    .join("\n      ");

  return `<section class="panel">
    <h2>Where each one ended</h2>
    <div class="grid">
      ${cells}
    </div>
  </section>`;
}

/** One sweep's sheet: every scenario's outcome, and the last picture each one reached. */
export function renderSuiteSheet(suite) {
  const runs = suite.runs ?? [];
  const unexpected = runs.filter((run) => !suiteVerdict(run).ok);
  const columns = Math.min(4, Math.max(1, runs.length));
  const verdict =
    unexpected.length === 0
      ? `<span class="verdict">Every scenario did what it was meant to do.</span>`
      : `<span class="verdict is-gap">${escapeHtml(String(unexpected.length))} did not do what
      ${unexpected.length === 1 ? "it was" : "they were"} meant to: ${escapeHtml(
        unexpected.map((run) => run.scenario ?? run.dir).join(", "),
      )}.</span>`;

  return sheetDocument({
    title: `Driver sweep, ${suite.suite}`,
    heading: `Driver sweep, ${suite.suite}`,
    intro: `${escapeHtml(String(runs.length))} ${runs.length === 1 ? "scenario" : "scenarios"}, one
      run each, ${escapeHtml(suite.theme ?? "")} theme.
      <br>${verdict} ${escapeHtml(suite.startedAt ?? "")}
      ${
        suite.complete
          ? ""
          : `<br><span class="verdict is-gap">The sweep itself did not finish.</span>`
      }`,
    css: `${CSS}
    .grid { grid-template-columns: repeat(${columns}, minmax(0, 1fr)); }`,
    body: [suiteRunsPanel(suite), suiteShotsPanel(suite)].filter(Boolean).join("\n  "),
  });
}

/**
 * What a run directory can contain, which is its privacy class rather than a statistic.
 *
 * Three answers, not two. D13 added `handDriven` because a run somebody typed into can hold
 * anything they typed or pasted, including text from a real vault. Live mode adds the third: a
 * scripted run contains nothing real by construction, authored frames against a fixture vault,
 * but a live run's transcript holds **real model output** even when no person touched it. A
 * column that called that "scripted" would be understating what is in the directory.
 */
function holdsText(run) {
  if (run.handDriven) return "anything typed";
  return run.provider?.kind === "live" ? "real model output" : "authored frames";
}

/** The index over `dev/driver/out/`, newest first. */
export function renderRunIndex(runs) {
  const rows = runs
    .map((run) => {
      const gap = run.complete ? "" : ' class="is-gap"';
      // Every failed step, not only the checkpoints: a click that never landed is a gap in the
      // same sense, and an "incomplete, 0 gaps" row would read as a contradiction.
      const missing = (run.steps ?? []).filter((step) => step.ok === false).length;
      const name = run.scenario ?? (run.vault ? `sandbox, ${run.vault}` : "");
      const matrix = run.kind === "matrix";
      const suite = run.kind === "suite";
      // A matrix or suite directory holds no steps of its own; what it has is other runs, and how
      // many of them went wrong is the number a reader scans its row for.
      const models = (run.runs ?? []).length;
      const unexpected = suite ? (run.runs ?? []).filter((entry) => !suiteVerdict(entry).ok) : [];
      const outcome = suite
        ? `${models} ${models === 1 ? "scenario" : "scenarios"}, ${unexpected.length} unexpected`
        : matrix
          ? `${models} ${models === 1 ? "model" : "models"}, ${(run.skipped ?? []).length} skipped`
          : run.complete
            ? "complete"
            : `incomplete, ${missing} gap${missing === 1 ? "" : "s"}`;
      const model = matrix
        ? `matrix, ${run.modelProvider ?? ""}`
        : suite
          ? ""
          : (run.model?.key ?? run.askedForModel ?? "");
      return `<tr>
        <td><a href="${escapeHtml(run.dir)}/index.html">${escapeHtml(run.dir)}</a></td>
        <td>${escapeHtml(name)}</td>
        <td>${escapeHtml(model)}</td>
        <td>${escapeHtml(matrix ? "matrix" : suite ? "sweep" : (run.mode ?? ""))}</td>
        <td${suite ? (unexpected.length === 0 ? "" : ' class="is-gap"') : matrix && run.complete ? "" : gap}>${escapeHtml(outcome)}</td>
        <td>${holdsText(run)}</td>
        <td>${escapeHtml(String(run.console ?? 0))}</td>
      </tr>`;
    })
    .join("\n      ");

  const body = `<section class="panel">
    <h2>Runs</h2>
    <table class="runs">
      <tr><th>run</th><th>scenario</th><th>model</th><th>mode</th><th>outcome</th><th>holds</th><th>console</th></tr>
      ${rows}
    </table>
  </section>`;

  return sheetDocument({
    title: "Live scenario driver runs",
    heading: "Live scenario driver runs",
    intro: `${runs.length} retained ${runs.length === 1 ? "run" : "runs"}, newest first.
      A hand-driven run can hold anything that was typed into it, a live one holds real model
      output, and a scripted one holds only authored frames against a fixture vault.`,
    css: CSS,
    body,
  });
}

// The run directory: what a run leaves behind to be re-read (RFC-0013, plan section 4.4).
//
// Written incrementally, never buffered to the end (plan decision D8). A run that dies at its
// third step must leave the first two shots on disk, a manifest that says the run is incomplete,
// and a sheet that shows where it stopped, because the runs most worth reading are the ones that
// failed. Buffering would mean those are the runs that produce nothing.
//
// Every step goes into one ledger, in order: checkpoints, clicks, keystrokes, shots, and notes.
// One ledger rather than separate lists because plan section 4.3 wants every shot to carry the
// checkpoint it followed, and a picture separated from its claim about when it was taken is the
// specific lie this instrument exists to prevent.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderMatrixSheet, renderRunIndex, renderRunSheet, renderSuiteSheet } from "./sheet.mjs";

/**
 * Opens a run directory and returns the ledger that writes into it.
 *
 * @param consoleLines the live array the runner pushes renderer output into, so every flush
 *   renders the console as it stands rather than only at the end.
 */
export function openRunDirectory({ outDir, name, manifest, consoleLines = [] }) {
  const dir = join(outDir, name);
  mkdirSync(join(dir, "shots"), { recursive: true });
  mkdirSync(join(dir, "state"), { recursive: true });

  // `handDriven` is a privacy class, not a statistic. A scripted scenario contains nothing real
  // by construction: authored frames, an authored prompt, a fixture vault. A run somebody typed
  // into can contain anything they typed or pasted, and its transcript and shots hold it. Runs
  // are retained and gitignored either way; this is what lets a directory state which kind it is
  // without anyone re-reading the transcript to find out.
  const state = {
    ...manifest,
    complete: false,
    handDriven: false,
    steps: [],
    checkpoints: [],
    console: 0,
  };

  let lastCheckpoint = null;

  const flush = () => {
    state.console = consoleLines.length;
    state.checkpoints = state.steps
      .filter((step) => step.kind === "checkpoint")
      .map((step) => ({ name: step.label, arrived: step.ok, ...(step.ms ? { ms: step.ms } : {}) }));
    writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(state, null, 2)}\n`);
    writeFileSync(join(dir, "index.html"), renderRunSheet(state, consoleLines.join("\n")));
  };

  const push = (step) => {
    state.steps.push({ n: state.steps.length + 1, ...step });
    flush();
  };

  flush();

  return {
    dir,

    note(patch) {
      Object.assign(state, patch);
      flush();
    },

    /** The one assertion: arrival. A checkpoint that did not arrive is recorded, never dropped. */
    checkpoint(label, ok, { ms, detail } = {}) {
      if (ok) lastCheckpoint = label;
      push({ kind: "checkpoint", label, ok, ...(ms ? { ms } : {}), ...(detail ? { detail } : {}) });
    },

    action(kind, label, ok, detail) {
      push({ kind, label, ok, ...(detail ? { detail } : {}) });
    },

    shot(label, file, stateFile, readout) {
      push({
        kind: "shot",
        label,
        ok: true,
        shot: file,
        after: lastCheckpoint,
        ...(stateFile ? { stateFile } : {}),
        ...(readout ? { readout } : {}),
      });
    },

    file(fileName, contents) {
      writeFileSync(join(dir, fileName), contents);
      return join(dir, fileName);
    },

    lastCheckpoint() {
      return lastCheckpoint;
    },

    /** The manifest as it stands. What a matrix sheet is composed from, without re-reading it. */
    snapshot() {
      return { dir: name, ...state };
    },
  };
}

/**
 * The sheet above a matrix run: one column per model, the same checkpoint side by side.
 *
 * Written incrementally like a run directory and for the same reason (D8). A matrix is the
 * slowest thing this instrument does, one whole Obsidian launch per model, so the one killed
 * halfway is exactly the one that must still be readable.
 *
 * A model that never ran is a column too. Dropping it would let "not judged" read as "judged and
 * did badly", which is the failure this comparison exists to end: the standing judgements about
 * local models are suspect precisely because nobody can now reconstruct what was and was not
 * actually tried.
 */
/**
 * The sheet above a sweep: one run per scenario, in series, read in one place.
 *
 * Written incrementally like everything else here, and for the sharpest version of the same
 * reason: a sweep is minutes long and the scenario that hangs is the one somebody will kill. What
 * ran before it must already be on disk and already be readable.
 */
export function openSuiteDirectory({ outDir, name, manifest }) {
  const dir = join(outDir, name);
  mkdirSync(dir, { recursive: true });

  const state = { kind: "suite", ...manifest, complete: false, handDriven: false, runs: [] };

  const flush = () => {
    writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(state, null, 2)}\n`);
    writeFileSync(join(dir, "index.html"), renderSuiteSheet(state));
  };
  flush();

  return {
    dir,

    note(patch) {
      Object.assign(state, patch);
      flush();
    },

    /** One finished scenario, as its own run directory left it. */
    addRun(run) {
      state.runs.push(run);
      if (run.handDriven) state.handDriven = true;
      flush();
    },
  };
}

export function openMatrixDirectory({ outDir, name, manifest }) {
  const dir = join(outDir, name);
  mkdirSync(dir, { recursive: true });

  const state = { kind: "matrix", ...manifest, complete: false, handDriven: false, runs: [], skipped: [] };

  const flush = () => {
    writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(state, null, 2)}\n`);
    writeFileSync(join(dir, "index.html"), renderMatrixSheet(state));
  };
  flush();

  return {
    dir,

    note(patch) {
      Object.assign(state, patch);
      flush();
    },

    /** One finished model, as its own run directory left it. */
    addRun(run) {
      state.runs.push(run);
      if (run.handDriven) state.handDriven = true;
      flush();
    },

    skip(model, reason) {
      state.skipped.push({ model, reason });
      flush();
    },
  };
}

/** Every retained run, newest first, read from the manifests themselves. */
export function readRuns(outDir) {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse()
    .map((name) => {
      try {
        return { dir: name, ...JSON.parse(readFileSync(join(outDir, name, "manifest.json"), "utf8")) };
      } catch {
        return { dir: name, complete: false, error: "no readable manifest" };
      }
    });
}

export function writeRunIndex(outDir) {
  if (!existsSync(outDir)) return;
  writeFileSync(join(outDir, "index.html"), renderRunIndex(readRuns(outDir)));
}

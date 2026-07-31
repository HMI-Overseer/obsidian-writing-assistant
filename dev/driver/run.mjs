// The live scenario driver (RFC-0013): the real Obsidian, an isolated profile, a seeded
// disposable vault, and either a scripted scenario, a real provider, or the maintainer's own
// hands.
//
//   npm run drive              # ask what to do, in numbered lists
//   npm run drive -- --last    # repeat the previous run's choices
//   npm run drive -- --no-build
//
// There is no `--sandbox`, no `--takeover`, no `--keep-open`, no `--clean`, and no `--matrix`.
// Those are modes and list entries, and a mode that only exists as a flag is a mode nobody
// finds. Flags here only ever repeat a choice already made.
//
// It needs no special build. The bridge is injected over CDP, and the scripted provider is
// appended to the copy of the bundle installed into the scratch vault, so the plugin's own
// source carries nothing for the driver's benefit and a release build is what runs. A live run
// appends nothing at all: a real model decides how many rounds a turn has, so there is no script
// to arm and the installed artifact is the release build untouched.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { resolveObsidianExecutable } from "../visual/lib/obsidianInstall.mjs";
import {
  assertBridgeShape,
  installBridge,
  readCheckpointRegistry,
  readSelectableModels,
  readState,
  stopEngine,
} from "./lib/bridge.mjs";
import { canonicalTranscriptJson, CANONICAL_STRIPPED_KEYS } from "./lib/canonical.mjs";
import {
  markScratchDetached,
  removeScratchQuietly,
  runClean,
  scratchSummary,
} from "./lib/clean.mjs";
import { handOver } from "./lib/handoff.mjs";
import { INSTALLED_SETTINGS_PATH, readLiveProviderSettings } from "./lib/liveSettings.mjs";
import { askLiveModel, preflight, reachability, selectModelInUi } from "./lib/models.mjs";
import {
  createTerminal,
  readLastChoices,
  repeatableChoices,
  writeLastChoices,
} from "./lib/picker.mjs";
import {
  openMatrixDirectory,
  openRunDirectory,
  openSuiteDirectory,
  writeRunIndex,
} from "./lib/runDirectory.mjs";
import {
  frameDescription,
  listFixtureIds,
  listFrameIds,
  listScenarioIds,
  loadScenario,
  mergeSettings,
} from "./lib/scenario.mjs";
import { createScenarioApi } from "./lib/scenarioApi.mjs";
import { suiteVerdict } from "./lib/sheet.mjs";
import { validateDriverScript } from "./lib/script.mjs";
import { grantTrust, launchArgs, seedRun } from "./lib/seed.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const OUT = join(HERE, "out");
const LAST = join(HERE, ".last.json");

/** Ceilings on a wait that has stopped arriving, never a duration anything waits out. */
const APP_LAUNCH_TIMEOUT_MS = 60_000;

const MODES = [
  {
    label: "sandbox",
    detail: "seed a disposable vault, launch it, hand it over. no scenario.",
    value: "sandbox",
  },
  { label: "walk", detail: "run a scenario, write a run directory, close.", value: "walk" },
  {
    label: "walk, then take over",
    detail: "run a scenario, then hand the app over instead of exiting.",
    value: "takeover",
  },
  { label: "walk, pausing at every shot", detail: "each shot is a breakpoint.", value: "pause" },
  {
    label: "clean",
    detail: "remove scratch vaults and run directories left by earlier runs.",
    value: "clean",
  },
];

/** Unwinds a scenario when the maintainer ends the run from a pause point. */
class HandoverExit extends Error {
  constructor(choice) {
    super(`handover ended the run (${choice})`);
    this.name = "HandoverExit";
    this.choice = choice;
  }
}

// ─── choices ────────────────────────────────────────────────────────────────────────────────

function askTheme(terminal, preferred) {
  const themes = [
    { label: "dark", value: "dark" },
    { label: "light", value: "light" },
  ];
  if (preferred === "light") themes.reverse();
  return terminal.choose("theme", themes);
}

async function askChoices(terminal) {
  const mode = await terminal.choose("how do you want to drive", MODES);
  if (mode === "clean") return { mode };

  if (mode === "sandbox") {
    const fixture = await terminal.choose(
      "vault",
      listFixtureIds().map((id) => ({ label: id, value: id })),
    );
    const provider = await terminal.choose("provider", [
      ...listFrameIds().map((id) => ({
        label: id,
        detail: frameDescription(id),
        value: { frames: id, live: null },
      })),
      {
        label: "live",
        // The one place a sandbox costs money. Named, so nobody reaches it by accident.
        detail: "your own provider settings, real models, real tokens. pick a model in the app.",
        value: { frames: null, live: { kind: "hand", provider: null, modelId: null } },
      },
      {
        label: "none",
        detail: "the release build untouched, on the fixture's settings",
        value: { frames: null, live: null },
      },
    ]);
    return {
      mode,
      scenario: null,
      suite: null,
      fixture,
      frames: provider.frames,
      theme: await askTheme(terminal),
      live: provider.live,
    };
  }

  const chosen = await terminal.choose("scenario", await scenarioOptions());
  if (chosen.suite) {
    return {
      mode,
      scenario: null,
      suite: chosen.suite,
      // A sweep spans scenarios, and a scenario carries its own vault and frames.
      fixture: null,
      frames: null,
      theme: await askTheme(terminal),
      live: null,
    };
  }

  const scenario = await loadScenario(chosen.scenario);
  return {
    mode,
    scenario: scenario.id,
    suite: null,
    fixture: scenario.vault,
    frames: scenario.provider.frames,
    theme: await askTheme(terminal, scenario.theme),
    // A live scenario's model needs the app running to be asked about, so it is filled in after
    // a launch rather than here. See `resolveLive`, and RFC-0013's unresolved question 6.
    live: null,
  };
}

/**
 * The scenario list, grouped by what choosing one costs you.
 *
 * Simulated first, because that is where most defects are found and none of it spends anything.
 * Live second, marked as a group rather than by a prefix inside a description, because "this one
 * costs real tokens" is the kind of thing a reader should not have to notice in prose. The
 * instrument's own alarms last, because they are meant to fail and should not be entries 1 and 2
 * that somebody picks by accident.
 *
 * The sweep is an entry in this list rather than a flag, for the same reason the matrix is an
 * entry in the model list: a mode that only exists as a flag is a mode nobody finds.
 */
async function scenarioOptions() {
  const scenarios = [];
  for (const id of listScenarioIds()) scenarios.push(await loadScenario(id));

  const simulated = scenarios.filter((s) => s.provider.kind !== "live" && !s.mustFail);
  const live = scenarios.filter((s) => s.provider.kind === "live");
  const alarms = scenarios.filter((s) => s.mustFail);
  const entry = (scenario) => ({
    label: scenario.id,
    detail: scenario.description,
    value: { scenario: scenario.id, suite: null },
  });

  return [
    {
      group: "everything at once",
      label: "sweep the simulated scenarios",
      detail: `${simulated.length + alarms.length} runs in series, one directory each, no tokens spent`,
      value: { scenario: null, suite: "simulated" },
    },
    ...simulated.map((scenario) => ({
      ...entry(scenario),
      group: "simulated, authored frames. free, repeatable, and where most defects turn up",
    })),
    ...live.map((scenario) => ({
      ...entry(scenario),
      group: "live, a real provider. real tokens or a real local model, and not repeatable",
    })),
    ...alarms.map((scenario) => ({
      ...entry(scenario),
      group: "the instrument's own alarms. these are meant to fail, and a sweep includes them",
    })),
  ];
}

/**
 * Which scenarios a named sweep covers.
 *
 * The self-tests are in it, with their expectation inverted rather than excluded. A sweep is what
 * gets run after a refactor, which is exactly when the question "does this instrument still
 * notice a missed click" needs answering, and leaving them out would have bought a green sheet by
 * declining to ask.
 */
async function suiteScenarios(suite) {
  const scenarios = [];
  for (const id of listScenarioIds()) {
    const scenario = await loadScenario(id);
    if (suite === "simulated" && scenario.provider.kind !== "live") scenarios.push(scenario);
  }
  if (scenarios.length === 0) throw new Error(`The "${suite}" sweep covers no scenarios.`);
  return scenarios;
}

// ─── launch ─────────────────────────────────────────────────────────────────────────────────

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

function runCommand(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    // The driver owns stdin for the whole run, so no child of it gets a share. Measured, not
    // guessed: a build child that inherited a piped stdin wedged with the terminal's readline
    // holding the same descriptor, and the run sat there with nothing to show for it.
    const child = spawn(command, args, {
      stdio: ["ignore", "inherit", "inherit"],
      shell: false,
      cwd: REPO,
    });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} ${args.join(" ")} exited with ${code ?? "unknown"}`));
    });
  });
}

/** A port the OS says is free, so two runs cannot collide on a fixed one. */
function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

/**
 * Waits for the debugging endpoint to answer.
 *
 * A bounded retry against a process the driver cannot be notified about, not a sleep: nothing
 * proceeds on elapsed time, and the deadline only decides when to stop asking. It also returns
 * the engine versions the manifest records.
 */
async function waitForEndpoint(port) {
  const deadline = Date.now() + APP_LAUNCH_TIMEOUT_MS;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return await response.json();
    } catch {
      // The app has not opened the port yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`No debugging endpoint on port ${port} after ${APP_LAUNCH_TIMEOUT_MS}ms.`);
    }
    await new Promise((tick) => setTimeout(tick, 250));
  }
}

/** The renderer running the vault, as opposed to any helper target attached to the same app. */
async function obsidianPage(browser) {
  const deadline = Date.now() + APP_LAUNCH_TIMEOUT_MS;
  for (;;) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.url().includes("obsidian.md")) return page;
      }
    }
    if (Date.now() > deadline) throw new Error("No Obsidian renderer appeared over CDP.");
    await new Promise((tick) => setTimeout(tick, 250));
  }
}

function stopApp(child) {
  if (child.exitCode !== null) return;
  child.kill();
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  }
}

/**
 * Seeds a vault, launches Obsidian on it, attaches, and gets as far as an open chat view.
 *
 * Shared by a walk and by the chooser launch that live mode's model question needs, because they
 * differ in what they do with the app rather than in how they get one.
 */
async function bringUpApp({ fixture, theme, script, settings, run, consoleLines }) {
  const vaultId = `lmsadriver${stamp().replace("-", "")}`;
  const seeded = seedRun({ fixture, theme, vaultId, script, settings, run });
  const port = await freePort();
  const executable = resolveObsidianExecutable();
  const app = spawn(executable, launchArgs({ profileDir: seeded.profileDir, port }), {
    stdio: "ignore",
    shell: false,
    // So "detach" can leave the app running after the driver exits.
    detached: true,
  });

  try {
    const engines = await waitForEndpoint(port);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = await obsidianPage(browser);

    // Capture from attachment onward, so anything the plugin logs while loading is in the
    // artifact. This codebase forbids console.log and reserves console.error for genuine errors,
    // so any output at all is evidence; it is displayed, never asserted on.
    page.on("console", (message) => consoleLines.push(`[${message.type()}] ${message.text()}`));
    page.on("pageerror", (error) => consoleLines.push(`[pageerror] ${error.message}`));

    // Step 7 of the recipe, then a reload so the trust key is in place before the plugin would
    // load. The bridge is installed as an init script first, so it survives that reload and every
    // later one the maintainer triggers by hand while driving.
    await grantTrust(page, vaultId);
    await installBridge(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    return { app, browser, page, engines, seeded, executable, vaultId };
  } catch (error) {
    stopApp(app);
    throw error;
  }
}

// ─── live mode ──────────────────────────────────────────────────────────────────────────────

/**
 * Which models a live run will spend on.
 *
 * RFC-0013's unresolved question 6 is here and is not dodged: the list has to come from the
 * running app, so an Obsidian window opens before the terminal asks anything. What this does
 * about it is say so first, and close that window again once the answer is in, so the walk's own
 * app is the only one left. `--last` skips this launch entirely for a single model, because the
 * choice is already made and the walk's own preflight is what gates it.
 */
async function resolveLive({ terminal, choices, scenario, livePatch, consoleLines }) {
  const stored = choices.live;
  if (stored?.kind === "hand") return { live: stored, models: [], skipped: [] };
  if (stored?.kind === "model") {
    // The picker answered this already. Reachability is still checked, by the walk's own app.
    return { live: stored, models: [{ key: stored.key, modelId: stored.modelId }], skipped: [] };
  }

  terminal.say("");
  terminal.say(`  ${scenario.id} runs live, so it needs a real model.`);
  terminal.say(`  Provider settings and credentials come from ${INSTALLED_SETTINGS_PATH}.`);
  terminal.say("  Obsidian opens now so the app itself can say what you can pick, then closes.");

  const up = await bringUpApp({
    fixture: choices.fixture,
    theme: choices.theme,
    script: null,
    settings: livePatch,
    run: null,
    consoleLines,
  });

  try {
    const api = createScenarioApi({ page: up.page, record: silentRecord(), onBreakpoint: null });
    await api.awaitCheckpoint("plugin-ready");
    await assertBridgeShape(up.page, false);
    await up.page.evaluate(() => window.__lmsaDriver.openChat());
    await api.awaitCheckpoint("view-open");
    const offered = await readSelectableModels(up.page);

    if (stored?.kind === "matrix") {
      const list = offered.models.filter((model) => model.provider === stored.provider);
      return {
        live: stored,
        models: list.filter((model) => reachability(model, offered.discoveryError).ok),
        skipped: list
          .filter((model) => !reachability(model, offered.discoveryError).ok)
          .map((model) => ({ model, reason: reachability(model, offered.discoveryError).reason })),
      };
    }

    const chosen = await askLiveModel(terminal, offered, scenario.provider.only);
    const live = chosen.matrix
      ? { kind: "matrix", provider: chosen.provider, modelId: null, key: null }
      : {
          kind: "model",
          provider: chosen.provider,
          modelId: chosen.models[0].modelId,
          key: chosen.models[0].key,
        };
    return {
      live,
      models: chosen.models,
      skipped: chosen.skipped.map((model) => ({
        model,
        reason: reachability(model, offered.discoveryError).reason,
      })),
    };
  } finally {
    await up.browser.close().catch(() => {});
    stopApp(up.app);
    // Nothing was recorded from this launch and nothing can be inspected in it, so it does not
    // join the pile the clean mode exists for. Best effort: on Windows the OS can still hold the
    // profile's cache open for a moment after the app is killed, and tidying up must not be the
    // thing that takes a run down.
    if (!removeScratchQuietly(up.seeded.root)) {
      terminal.say("  the chooser's scratch vault is still held by the OS; the clean mode has it");
    }
  }
}

/** A ledger that writes nothing, for the chooser launch, which leaves no run directory. */
function silentRecord() {
  return {
    dir: null,
    note() {},
    checkpoint() {},
    action() {},
    shot() {},
    file() {},
    lastCheckpoint: () => null,
  };
}

function providerLabel({ script, live, model }) {
  if (script) return `scripted, ${script.id}`;
  if (model) return `live, ${model.key}`;
  if (live?.kind === "hand") return "live, your own provider settings";
  return "none, the vault's own settings";
}

// ─── one run ────────────────────────────────────────────────────────────────────────────────

/**
 * Seed, launch, walk, and write a run directory. One model, one theme, one directory.
 *
 * @returns the ledger and whether the driver detached from the app it launched.
 */
async function performRun({ choices, scenario, script, livePatch, model, name }) {
  const consoleLines = [];
  // A scenario carries its own vault, so a sweep can span fixtures without the picker having
  // asked about any of them.
  const fixture = scenario?.vault ?? choices.fixture;
  // Opened before anything is seeded or launched, so even a run that fails during setup leaves a
  // directory that says what it was trying to do (D8).
  const live = scenario?.provider.kind === "live" || choices.live?.kind === "hand";
  const record = openRunDirectory({
    outDir: OUT,
    name,
    consoleLines,
    manifest: {
      scenario: scenario?.id ?? null,
      description: scenario?.description ?? null,
      mode: choices.mode,
      vault: fixture,
      theme: choices.theme,
      // Carried into the run's own manifest so a sweep sheet reads the expectation from the run
      // rather than having to re-load the scenario that produced it.
      mustFail: scenario?.mustFail === true,
      provider: script
        ? { kind: "scripted", frames: script.id }
        : live
          ? { kind: "live", only: scenario?.provider.only ?? null }
          : { kind: "none" },
      // A live run is not repeatable and says so on its own face, because its whole value is that
      // it cannot be recreated. A scripted one is, against the same frames.
      repeatable: !live,
      // Never the patch itself: it carries the maintainer's real API keys, and a run directory is
      // the artifact that gets re-read and may be shared. The scratch vault holds them; this
      // says where they came from.
      credentials: live ? `the installed plugin's settings, ${INSTALLED_SETTINGS_PATH}` : null,
      // The model a live run asked for. What it *resolved* is written after the app confirms it.
      askedForModel: model?.key ?? null,
      settingsPatch: scenario?.settings ?? null,
      canonicalStrippedKeys: CANONICAL_STRIPPED_KEYS,
      startedAt: new Date().toISOString(),
    },
  });
  terminal.say(`\n  run directory: ${record.dir.replace(`${REPO}${sep}`, "")}`);

  let up = null;
  let detached = false;

  try {
    up = await bringUpApp({
      fixture,
      theme: choices.theme,
      script,
      settings: mergeSettings(livePatch, scenario?.settings ?? null),
      run: record.dir,
      consoleLines,
    });
    record.note({
      vaultId: up.vaultId,
      vaultDir: up.seeded.vaultDir,
      obsidianExecutable: up.executable,
      pinnedAsar: up.seeded.pinnedAsar,
      artifacts: up.seeded.artifacts,
      // The installed bundle is either the release artifact plus the driver's epilogue, or the
      // release artifact untouched. A run states which; it must not be inferred from the hashes.
      epilogue: up.seeded.epilogue,
      engines: up.engines,
    });

    let api = null;
    const pause = async (at, resumable) => {
      // Recorded before the handover, not after, so a run that dies while somebody is driving it
      // still says that somebody was driving it.
      record.note({ handDriven: true });
      const next = await handOver({
        terminal,
        seeded: up.seeded,
        record,
        at,
        resumable,
        provider: providerLabel({ script, live: choices.live, model }),
        shot: (label) => api.shot(label, { breakpoint: false }),
        snapshot: () => readState(up.page),
      });
      if (next !== "continue") throw new HandoverExit(next);
    };

    api = createScenarioApi({
      page: up.page,
      record,
      onBreakpoint: choices.mode === "pause" ? (label) => pause(`shot "${label}"`, true) : null,
    });

    // The plugin being *in* the registry and the layout being ready, not merely the registry
    // existing. Restricted mode and a failed load both look like an empty registry, and waiting on
    // the wrong one turns a load failure into a confusing bridge assertion a few lines below.
    await api.awaitCheckpoint("plugin-ready");
    // The assertion that makes reaching honest. It names every path the bridge depends on, so a
    // rename fails the run here instead of producing a plausible screenshot of the wrong thing.
    await assertBridgeShape(up.page, false);
    record.note({ checkpointRegistry: await readCheckpointRegistry(up.page) });

    await up.page.evaluate(() => window.__lmsaDriver.openChat());
    await api.awaitCheckpoint("view-open");
    await assertBridgeShape(up.page, true);

    if (script) {
      await up.page.evaluate((armed) => window.__lmsaDriver.arm(armed), script);
      record.action("arm", `scripted provider, ${script.id}`, true);
    }

    if (model) {
      // The reachability preflight, against the app that is about to do the walk rather than the
      // one the picker asked. A model that has unloaded since then fails here, with a plain
      // reason, instead of halfway through a scenario that then reads as a defect.
      const offered = await readSelectableModels(up.page);
      const resolved = preflight(offered, model.key);
      record.action("preflight", `${resolved.key}, ${reachability(resolved).reason}`, true);
      record.note({ model: await selectModelInUi(api, resolved) });
    }

    if (scenario) await scenario.run(api);

    if (choices.mode === "sandbox" || choices.mode === "takeover") {
      await pause(scenario ? `the end of ${scenario.id}` : null, false);
    }

    record.note({ complete: true });
  } catch (error) {
    if (error instanceof HandoverExit) {
      detached = error.choice === "detach";
      record.note({ complete: true, endedAt: "handover" });
    } else {
      record.note({ error: error instanceof Error ? error.message : String(error) });
      process.exitCode = 1;
      console.error(error);
    }
  } finally {
    // Detaching leaves the app under hand control, so the transcript would be a snapshot of a
    // moment that has already moved on. Everything else gets one, including a failed run: the page
    // reference is reused rather than re-resolved, so a run that died with the app is not made to
    // wait out the launch timeout again before its artifacts are written.
    if (detached && up) {
      // Nothing more is recorded, so leave no observer running inside an app the maintainer keeps.
      await stopEngine(up.page).catch(() => {});
      markScratchDetached(up.seeded.root);
    } else if (up) {
      try {
        const state = await readState(up.page);
        record.file("transcript.json", `${JSON.stringify(state.messages, null, 2)}\n`);
        record.file("transcript.canonical.json", canonicalTranscriptJson(state.messages));
        record.file("state.json", `${JSON.stringify(state, null, 2)}\n`);
        record.note({
          messageCount: state.messageCount,
          // The whole summary, not a type-and-state projection of it. The sheet's turn panel is
          // what a reader reaches a verdict from on an aborted or a tool-bearing run, and a tool
          // step with its name and lifecycle but no arguments and no result is not one.
          turnItems: state.turnItems,
          turnStatus: state.turnStatus,
          scriptId: state.scriptId,
        });
      } catch (error) {
        record.note({ transcriptError: error instanceof Error ? error.message : String(error) });
      }
    }

    record.file("console.log", `${consoleLines.join("\n")}\n`);
    record.note({ finishedAt: new Date().toISOString(), detached });
    writeRunIndex(OUT);

    if (up) {
      if (detached) {
        terminal.say(`\n  the app is still running, on ${up.seeded.vaultDir}`);
        up.app.unref();
      } else {
        await up.browser.close().catch(() => {});
        stopApp(up.app);
      }
    }
    terminal.say(`  wrote ${record.dir.replace(`${REPO}${sep}`, "")}`);
  }

  return { record, detached };
}

// ─── the run ────────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const noBuild = argv.includes("--no-build");
const terminal = createTerminal();

const choices = argv.includes("--last")
  ? repeatableChoices(
      readLastChoices(LAST),
      MODES.map((mode) => mode.value),
    )
  : await askChoices(terminal);
if (!choices) {
  // Refused rather than partially honoured: a stored shape this driver no longer understands
  // would otherwise skip a question whose answer it thinks it has.
  terminal.say("  no previous run this driver still understands. run `npm run drive` and choose.");
  terminal.close();
  process.exit(1);
}

if (choices.mode === "clean") {
  await runClean(terminal, OUT);
  writeRunIndex(OUT);
  terminal.close();
  process.exit(0);
}

// Stored as soon as the questions are answered, and again once a live run's model is resolved, so
// a run that dies before it launches still leaves the answers `--last` would repeat. A live
// scenario's `live` is null at this point, which is the honest record of a choice not yet made.
writeLastChoices(LAST, choices);

const scenario = choices.scenario ? await loadScenario(choices.scenario) : null;

/**
 * Validated here, in Node, before anything launches.
 *
 * Stage 0 validated inside the page, which spent a whole launch to learn that a frame had a typo
 * in it. A sweep raises the stakes on that rule rather than changing it: every script it will use
 * is validated up front, so a typo in the seventh scenario fails in the first second rather than
 * four minutes in. A live scenario has no frames at all, because the rounds cursor is meaningless
 * when a real model decides how many rounds there are.
 */
function loadScript(frames) {
  if (!frames) return null;
  return validateDriverScript(
    JSON.parse(readFileSync(join(HERE, "frames", `${frames}.json`), "utf8")),
    frames,
  );
}

const script = loadScript(choices.frames);

const started = stamp();
let detachedFromApp = false;

// Everything that can fail before a run directory exists is inside this: the release build, the
// installed plugin's credentials, the chooser launch, and a model that cannot be reached. None of
// them has an artifact to be written into, and all of them must still put the terminal back.
try {
  const isLive = scenario?.provider.kind === "live" || choices.live?.kind === "hand";
  const livePatch = isLive ? readLiveProviderSettings() : null;

  if (!noBuild) {
    // The release build. Nothing in it knows about the driver, and this repository is the
    // maintainer's installed plugin, so a run now leaves a production artifact behind rather than
    // a development one.
    await runCommand(process.execPath, ["esbuild.config.mjs", "production"]);
  }

  const resolved =
    scenario?.provider.kind === "live"
      ? await resolveLive({ terminal, choices, scenario, livePatch, consoleLines: [] })
      : { live: choices.live ?? null, models: [], skipped: [] };
  choices.live = resolved.live;
  writeLastChoices(LAST, choices);

  if (choices.suite) {
    // One run per scenario, in series, each with its own seeded vault and its own launch. Sharing
    // one app across them would be faster and would destroy the property the whole instrument
    // rests on: a scenario must start from a vault nothing else has written to.
    const scenarios = await suiteScenarios(choices.suite);
    // Every script the sweep will need, validated before the first launch rather than as each
    // scenario comes up.
    const scripts = new Map(scenarios.map((entry) => [entry.id, loadScript(entry.provider.frames)]));

    const suite = openSuiteDirectory({
      outDir: OUT,
      name: `${started}-sweep-${choices.suite}`,
      manifest: {
        suite: choices.suite,
        mode: choices.mode,
        theme: choices.theme,
        startedAt: new Date().toISOString(),
      },
    });
    terminal.say(
      `\n  sweeping ${scenarios.length} scenarios, one run each\n  ` +
        suite.dir.replace(`${REPO}${sep}`, ""),
    );

    const swept = [];
    for (const entry of scenarios) {
      // A failing scenario does not stop the sweep. Its run directory records what happened and
      // the sheet above says so; stopping would hide every scenario after the first defect, which
      // is the opposite of what a sweep is for.
      const { record, detached } = await performRun({
        choices,
        scenario: entry,
        script: scripts.get(entry.id),
        livePatch,
        model: null,
        name: `${started}-${entry.id}`,
      });
      const snapshot = record.snapshot();
      suite.addRun(snapshot);
      swept.push(snapshot);
      const verdict = suiteVerdict(snapshot);
      terminal.say(`  ${verdict.ok ? " " : "!"} ${entry.id}: ${verdict.text}`);
      if (detached) {
        detachedFromApp = true;
        break;
      }
    }
    suite.note({ complete: !detachedFromApp, finishedAt: new Date().toISOString() });
    writeRunIndex(OUT);

    // A self-test failing is the sweep working, so the exit code is about the scenarios that did
    // not do what they said they would, not about how many runs ended in an error.
    const unexpected = swept.filter((run) => !suiteVerdict(run).ok);
    process.exitCode = unexpected.length > 0 ? 1 : 0;
    terminal.say(
      `\n  ${swept.length} scenarios, ${unexpected.length} unexpected\n  ` +
        suite.dir.replace(`${REPO}${sep}`, ""),
    );
  } else if (resolved.live?.kind === "matrix") {
    // One directory per model, and a sheet above them placing the same checkpoint from every
    // model side by side. That comparison is the whole point of the mode: the reason the standing
    // judgements about local models are suspect is that each model was seen once, under
    // conditions nobody can now reconstruct.
    const matrix = openMatrixDirectory({
      outDir: OUT,
      name: `${started}-${scenario.id}-matrix`,
      manifest: {
        scenario: scenario.id,
        description: scenario.description,
        mode: choices.mode,
        vault: choices.fixture,
        theme: choices.theme,
        provider: { kind: "live", only: scenario.provider.only ?? null },
        modelProvider: resolved.live.provider,
        repeatable: false,
        startedAt: new Date().toISOString(),
      },
    });
    // Named, never dropped: a model that was not judged must not read as a model that did badly.
    for (const entry of resolved.skipped) matrix.skip(entry.model, entry.reason);
    terminal.say(
      `\n  matrix: ${resolved.models.length} ${resolved.models.length === 1 ? "model" : "models"}, ` +
        `${resolved.skipped.length} skipped as unreachable\n  ${matrix.dir.replace(`${REPO}${sep}`, "")}`,
    );

    for (const model of resolved.models) {
      const { record, detached } = await performRun({
        choices,
        scenario,
        script,
        livePatch,
        model,
        name: `${started}-${scenario.id}-${slugModel(model.modelId)}`,
      });
      matrix.addRun(record.snapshot());
      if (detached) {
        detachedFromApp = true;
        break;
      }
    }
    matrix.note({ complete: !detachedFromApp, finishedAt: new Date().toISOString() });
    writeRunIndex(OUT);
    terminal.say(`  wrote ${matrix.dir.replace(`${REPO}${sep}`, "")}`);
  } else {
    const model = resolved.models[0] ?? null;
    const { detached } = await performRun({
      choices,
      scenario,
      script,
      livePatch,
      model,
      name: `${started}-${scenario?.id ?? `sandbox-${choices.fixture}`}${
        model ? `-${slugModel(model.modelId)}` : ""
      }`,
    });
    detachedFromApp = detached;
  }
} catch (error) {
  // Plainly, and once. A live run that cannot reach its model fails here rather than mid-walk,
  // which is the checkpoint-arrival rule applied one step earlier.
  console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  terminal.close();
  // Where the clean mode becomes discoverable: at the moment the number is in front of someone.
  terminal.say(`  ${scratchSummary().text} in the temp directory; the clean mode removes them\n`);
  if (detachedFromApp) process.exit(0);
}

/** A model id is a path-ish string (`qwen/qwen3.5-9b`), and a directory name is not. */
function slugModel(modelId) {
  return String(modelId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

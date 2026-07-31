// Stage 0 of the live scenario driver (RFC-0013): one complete repeatable turn, end to end.
//
// One hardcoded walk, no picker and no scenario loader, because this stage is a withdrawal gate
// rather than a phase. It exists to answer the one load-bearing claim the RFC's probe did not
// measure: whether launch, attach, and drive hold together well enough to produce two runs a
// person can compare. Everything that turns this into an instrument is Stage 1.
//
//   npm run drive                 # build, seed, launch, walk, write a run directory
//   npm run drive -- --no-build   # reuse the artifacts already on disk
//   npm run drive -- --theme light
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { resolveObsidianExecutable } from "../visual/lib/obsidianInstall.mjs";
import { canonicalTranscriptJson, CANONICAL_STRIPPED_KEYS } from "./lib/canonical.mjs";
import { grantTrust, launchArgs, seedRun } from "./lib/seed.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const OUT = join(HERE, "out");

const SCENARIO = "spike-prose-turn";
const FRAMES = "prose-turn";
const FIXTURE = "writing-basic";
const PROMPT = "Tighten the opening of chapter one.";

const COMPOSER_TEXTAREA = ".lmsa-chat-composer-textarea";
const COMPOSER_SEND = ".lmsa-chat-composer-send-btn";
const CHAT_ROOT = ".lmsa-root";

/** Ceilings on a wait that has stopped arriving, never a duration anything waits out. */
const APP_LAUNCH_TIMEOUT_MS = 60_000;
const PLUGIN_LOAD_TIMEOUT_MS = 60_000;
const TURN_TIMEOUT_MS = 60_000;

const argv = process.argv.slice(2);
const noBuild = argv.includes("--no-build");
const themeIndex = argv.indexOf("--theme");
const theme = themeIndex >= 0 && argv[themeIndex + 1] ? argv[themeIndex + 1] : "dark";

function stamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .slice(0, 15);
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: "inherit", shell: false, cwd: REPO });
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
 * The run directory, written as the walk proceeds rather than buffered to the end (D8).
 *
 * A run that dies at the third wait must leave the first two artifacts on disk with a manifest
 * that says the run is incomplete, because a failed run is the one most worth reading.
 */
function openRunDirectory(manifest) {
  const dir = join(OUT, `${stamp()}-${SCENARIO}`);
  mkdirSync(join(dir, "shots"), { recursive: true });
  const state = { ...manifest, complete: false, waits: [], console: 0 };

  const flush = () => {
    writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(state, null, 2)}\n`);
  };
  flush();

  return {
    dir,
    note(patch) {
      Object.assign(state, patch);
      flush();
    },
    wait(name, arrived, detail) {
      state.waits.push({ name, arrived, ...(detail ? { detail } : {}) });
      flush();
    },
    file(name, contents) {
      writeFileSync(join(dir, name), contents);
    },
  };
}

const script = JSON.parse(readFileSync(join(HERE, "frames", `${FRAMES}.json`), "utf8"));

if (!noBuild) {
  // D9: the driver builds first, and it builds the development bundle, because a production
  // build compiles the bridge out by design.
  await run(process.execPath, ["esbuild.config.mjs", "driver"]);
}

const vaultId = `lmsadriver${stamp().replace("-", "")}`;
const seeded = seedRun({ fixture: FIXTURE, theme, vaultId });
const port = await freePort();
const executable = resolveObsidianExecutable();

const record = openRunDirectory({
  scenario: SCENARIO,
  stage: "0-spike",
  providerMode: "scripted",
  frames: FRAMES,
  fixture: FIXTURE,
  theme,
  prompt: PROMPT,
  vaultId,
  obsidianExecutable: executable,
  pinnedAsar: seeded.pinnedAsar,
  artifacts: seeded.artifacts,
  canonicalStrippedKeys: CANONICAL_STRIPPED_KEYS,
});
console.log(`run directory: ${record.dir.replace(`${REPO}${sep}`, "")}`);

const app = spawn(executable, launchArgs({ profileDir: seeded.profileDir, port }), {
  stdio: "ignore",
  shell: false,
});

const consoleLines = [];
let browser = null;

try {
  const engines = await waitForEndpoint(port);
  record.note({ engines });

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await obsidianPage(browser);

  // Capture from attachment onward, so anything the plugin logs while loading is in the
  // artifact. This codebase forbids console.log and reserves console.error for genuine errors,
  // so any output at all is evidence; it is displayed, never asserted on.
  page.on("console", (message) => consoleLines.push(`[${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => consoleLines.push(`[pageerror] ${error.message}`));

  // Step 7 of the recipe, then a reload so the key is in place before the plugin would load.
  await grantTrust(page, vaultId);
  await page.reload({ waitUntil: "domcontentloaded" });

  await page.waitForFunction(() => Boolean(window.__lmsaDriver), null, {
    timeout: PLUGIN_LOAD_TIMEOUT_MS,
  });
  await page.evaluate(() => window.__lmsaDriver.ready());
  record.wait("plugin-ready", true);

  await page.evaluate(() => window.__lmsaDriver.openChat());
  await page.waitForSelector(COMPOSER_TEXTAREA, { timeout: PLUGIN_LOAD_TIMEOUT_MS });
  record.wait("view-open", true);

  await page.evaluate(
    ({ frames, id }) => window.__lmsaDriver.useScriptedProvider(frames, id),
    { frames: script, id: FRAMES },
  );
  record.wait("scripted-provider-installed", true);

  // D5: real input only. `ChatView.seedPrompt` exists and is tempting; a scenario that seeds
  // the composer through a method is not exercising the composer.
  await page.click(COMPOSER_TEXTAREA);
  await page.keyboard.type(PROMPT, { delay: 12 });
  await page.screenshot({ path: join(record.dir, "shots", "01-prompt-typed.png") });
  await page.click(COMPOSER_SEND);

  // Stage 0's single wait, written inline so the checkpoint engine is not on the critical path
  // of a withdrawal gate. A predicate over the bridge's own state(), never a duration.
  await page.waitForFunction(
    () => {
      const state = window.__lmsaDriver.state();
      return state.viewOpen && !state.generating && state.messageCount >= 2;
    },
    null,
    { timeout: TURN_TIMEOUT_MS },
  );
  record.wait("turn-settled", true);

  const state = await page.evaluate(() => window.__lmsaDriver.state());
  await page.screenshot({ path: join(record.dir, "shots", "02-turn-settled.png") });
  const chat = await page.$(CHAT_ROOT);
  if (chat) {
    await chat.screenshot({ path: join(record.dir, "shots", "03-chat-settled.png") });
  }

  record.file("transcript.json", `${JSON.stringify(state.messages, null, 2)}\n`);
  record.file("transcript.canonical.json", canonicalTranscriptJson(state.messages));
  record.file("state.json", `${JSON.stringify(state, null, 2)}\n`);
  record.note({
    complete: true,
    messageCount: state.messageCount,
    turnItems: state.turnItems.map((item) => ({ type: item.type, state: item.state ?? null })),
    scriptId: state.scriptId,
  });
} catch (error) {
  record.wait("run", false, error instanceof Error ? error.message : String(error));
  record.note({ error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
  console.error(error);
} finally {
  record.file("console.log", `${consoleLines.join("\n")}\n`);
  record.note({ console: consoleLines.length });
  if (browser) await browser.close().catch(() => {});
  stopApp(app);
}

console.log(`wrote ${record.dir.replace(`${REPO}${sep}`, "")}`);

// The launch and seeding recipe (RFC-0013), in the RFC's own order.
//
// Steps 2, 7, and 8 exist only because the 2026-07-30 probe found them, and none of the three
// was in the design beforehand:
//
//   2. a fresh profile downloads the current Obsidian release, so a run would be network
//      dependent and the application under test could change on a release day;
//   7. restricted mode is a hard gate, and seeding community-plugins.json alone loads nothing;
//   8. theme is per profile, so a run that does not pin it is not reproducing what it appears to.
//
// Step 7 is the only ordering constraint in the list: the trust key has to be in place before
// the plugin would load, and it can only be written once a renderer exists. See `grantTrust`.
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveObsidianAsar } from "../../visual/lib/obsidianInstall.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const FIXTURES = resolve(HERE, "..", "fixtures");

export const PLUGIN_ID = "writing-assistant-chat";
/** Release artifacts the driver installs, so a run exercises the build on disk. */
const BUILD_ARTIFACTS = ["main.js", "manifest.json", "styles.css"];

/** Where a scratch profile and vault live: the OS temp directory, never the repository. */
function scratchRoot() {
  return mkdtempSync(join(tmpdir(), "lmsa-driver-"));
}

/** SHA-256 of an installed artifact, so a run directory states which build it observed (D9). */
function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Steps 1 to 6 and 8. Everything that can be done before a process exists.
 *
 * Returns the paths and the manifest facts the runner needs, including the minted vault id that
 * makes step 7's localStorage key predictable.
 */
export function seedRun({ fixture, theme, vaultId }) {
  const fixtureDir = join(FIXTURES, fixture);
  const notesDir = join(fixtureDir, "notes");
  const settingsPath = join(fixtureDir, "settings.json");
  if (!existsSync(notesDir)) {
    throw new Error(`Fixture vault ${fixture} has no notes/ directory at ${notesDir}.`);
  }
  if (!existsSync(settingsPath)) {
    throw new Error(`Fixture vault ${fixture} has no settings.json at ${settingsPath}.`);
  }

  // 1. Scratch --user-data-dir per run, so the maintainer's own Obsidian stays open and its
  //    profile and registered vaults are never touched.
  const root = scratchRoot();
  const profileDir = join(root, "profile");
  const vaultDir = join(root, "vault");
  mkdirSync(profileDir, { recursive: true });

  // 2. Pin the application: copy the asar out of the real profile rather than letting a fresh
  //    one fetch whatever the current release is.
  const sourceAsar = resolveObsidianAsar();
  const asarName = sourceAsar.split(/[\\/]/).pop();
  cpSync(sourceAsar, join(profileDir, asarName));

  // 3. Copy the fixture's notes to the scratch vault. A fixture is never opened in place, so a
  //    run that mutates the vault leaves the committed copy clean.
  cpSync(notesDir, vaultDir, { recursive: true });

  // 4. Synthesize .obsidian/. None of it is copied, because under D7 none of it is committed.
  const configDir = join(vaultDir, ".obsidian");
  const pluginDir = join(configDir, "plugins", PLUGIN_ID);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(configDir, "community-plugins.json"), `${JSON.stringify([PLUGIN_ID])}\n`);
  // 8. Pin the theme from the scenario, never inheriting the profile default.
  writeFileSync(
    join(configDir, "appearance.json"),
    `${JSON.stringify({ theme: theme === "dark" ? "obsidian" : "moonstone" }, null, 2)}\n`,
  );

  // 5. Install the build, plus the scenario's settings written over the fixture's baseline.
  const artifacts = {};
  for (const artifact of BUILD_ARTIFACTS) {
    const source = join(REPO, artifact);
    if (!existsSync(source)) {
      throw new Error(`Missing ${artifact} at ${source}. Build before seeding.`);
    }
    cpSync(source, join(pluginDir, artifact));
    artifacts[artifact] = hashFile(source);
  }

  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  writeFileSync(join(pluginDir, "data.json"), `${JSON.stringify(settings, null, 2)}\n`);
  seedConversations(pluginDir, settings);

  // 6. Register and open, under a driver-minted vault id.
  writeFileSync(
    join(profileDir, "obsidian.json"),
    `${JSON.stringify(
      { vaults: { [vaultId]: { path: vaultDir, ts: 1, open: true } } },
      null,
      2,
    )}\n`,
  );

  return { root, profileDir, vaultDir, pluginDir, vaultId, artifacts, pinnedAsar: asarName };
}

/**
 * The conversation files the seeded `chatHistory` points at.
 *
 * Without them the restore path finds no conversation on disk, mints an empty one with no
 * model, and the view opens on "No model selected" with an inert composer. Derived from the
 * committed metas rather than authored separately, so the two cannot drift.
 */
function seedConversations(pluginDir, settings) {
  const metas = settings?.chatHistory?.conversations ?? [];
  if (metas.length === 0) return;

  const dir = join(pluginDir, "conversations");
  mkdirSync(dir, { recursive: true });
  for (const meta of metas) {
    const conversation = {
      id: meta.id,
      title: meta.title ?? "",
      createdAt: meta.createdAt ?? 0,
      updatedAt: meta.updatedAt ?? 0,
      modelId: meta.modelId ?? "",
      modelName: meta.modelName ?? "",
      messages: [],
      draft: "",
      approvalPosture: meta.approvalPosture ?? "ask",
    };
    writeFileSync(join(dir, `${meta.id}.json`), JSON.stringify(conversation));
  }
}

/**
 * Step 7. Clears restricted mode for the minted vault id.
 *
 * The probe found that seeding community-plugins.json is not sufficient: a vault opened for the
 * first time presents "Do you trust the author of this vault?" and loads no plugins at all.
 * Trust persists as `localStorage["enable-plugin-<vaultId>"]`, and because the driver mints the
 * id itself the key is predictable.
 *
 * This is the one step that cannot happen before launch, since it needs a renderer to write to.
 * Writing the key and then reloading is what puts it in place before the plugin would load,
 * which is the ordering constraint the recipe carries.
 */
export async function grantTrust(page, vaultId) {
  await page.evaluate((id) => {
    window.localStorage.setItem(`enable-plugin-${id}`, "true");
  }, vaultId);
}

/** Launch arguments: isolation, plus the debugging port the driver attaches to. */
export function launchArgs({ profileDir, port }) {
  return [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    // Playwright's CDP client sends an Origin header, which Chromium rejects by default.
    "--remote-allow-origins=*",
  ];
}

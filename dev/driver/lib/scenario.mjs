// A scenario: the walk, in the repository, versioned with the code it exercises (RFC-0013).
//
// Stage 0 shipped a five-key presence check on a module it called a walk, because the picker's
// second question is a list and a list of one hardcoded thing is not a list. This is that check
// grown into the thing RFC-0013 specifies: the object shape it names, validated, failing on an
// unknown key rather than ignoring it.
//
// Failing on an unknown key is the same rule the frame validator follows, for the same reason. A
// scenario whose `frames` key was typed as `frame` would otherwise run against no script at all
// and screenshot a composer that never sent anything, which reads as a plausible earlier state.
// The whole instrument exists to make that impossible.
//
// The directory is `scenarios/`, matching RFC-0013 and the plan. Stage 0 called it `walks/`;
// "walk" is what the driver does, and it survives as the name of the mode, but the artifact is a
// scenario in both design documents and there is no reason for the tree to disagree with them.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DRIVER = resolve(HERE, "..");
const SCENARIOS = join(DRIVER, "scenarios");
const FIXTURES = join(DRIVER, "fixtures");
const FRAMES = join(DRIVER, "frames");

const KEYS = ["id", "description", "vault", "theme", "provider", "settings", "mustFail", "run"];
const THEMES = ["dark", "light"];

function fail(id, detail) {
  throw new Error(`Scenario ${id}: ${detail}.`);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireText(scenario, id, key) {
  const value = scenario[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(id, `${key} must be a non-empty string`);
  }
  return value;
}

/** Scenario ids, which are also the module basenames and the run directory names. */
export function listScenarioIds() {
  if (!existsSync(SCENARIOS)) return [];
  return readdirSync(SCENARIOS, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
    .map((entry) => basename(entry.name, ".mjs"))
    .sort();
}

export function listFixtureIds() {
  return readdirSync(FIXTURES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function listFrameIds() {
  return readdirSync(FRAMES, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => basename(entry.name, ".json"))
    .sort();
}

export function frameDescription(id) {
  const raw = JSON.parse(readFileSync(join(FRAMES, `${id}.json`), "utf8"));
  return typeof raw.description === "string" ? raw.description : "";
}

/**
 * Checks a scenario against RFC-0013's shape.
 *
 * Everything it can check before a launch is checked before a launch, including that the fixture
 * vault and the frame file it names are on disk, because a scenario that names a fixture nobody
 * committed should not cost a real Obsidian launch to discover.
 *
 * @param moduleId the basename it was loaded from, which `id` must match.
 */
export function validateScenario(raw, moduleId) {
  if (!isPlainObject(raw)) fail(moduleId, "the module's default export must be an object");

  for (const key of Object.keys(raw)) {
    if (!KEYS.includes(key)) fail(moduleId, `unknown key "${key}". The shape is ${KEYS.join(", ")}`);
  }

  const id = requireText(raw, moduleId, "id");
  if (id !== moduleId) {
    fail(moduleId, `id is "${id}", which does not match the file it was loaded from`);
  }
  requireText(raw, id, "description");
  const vault = requireText(raw, id, "vault");
  if (!existsSync(join(FIXTURES, vault))) {
    fail(id, `vault "${vault}" has no fixture directory under dev/driver/fixtures`);
  }

  if (raw.theme !== undefined && !THEMES.includes(raw.theme)) {
    fail(id, `theme must be one of ${THEMES.join(", ")}`);
  }
  if (typeof raw.run !== "function") fail(id, "run must be a function taking the scenario API");
  if (raw.settings !== undefined && !isPlainObject(raw.settings)) {
    fail(id, "settings must be an object patched over the fixture's settings.json");
  }
  // The one inversion of the driver's one assertion, declared by the scenario rather than
  // inferred from its name. A self-test exists to fail, so a suite run that saw it *complete*
  // would be reporting that the instrument has stopped noticing, which is the finding. Naming it
  // in the scenario keeps that contract in the same file as the walk it describes.
  if (raw.mustFail !== undefined && raw.mustFail !== true) {
    fail(id, "mustFail is true or absent: a scenario that is meant to fail says so, once");
  }

  return {
    id,
    description: raw.description,
    vault,
    theme: raw.theme ?? "dark",
    provider: validateProvider(raw.provider, id),
    settings: raw.settings ?? null,
    mustFail: raw.mustFail === true,
    run: raw.run,
  };
}

/**
 * The provider a scenario declares: authored frames, or a real one.
 *
 * A live scenario names at most a provider *kind*, never a model. RFC-0013's model-selection
 * section argues that out: a committed scenario pinning `lmstudio:qwen3-30b-a3b` rots the day the
 * local lineup changes and then fails for a reason unrelated to the defect it pins, and a
 * declared capability requirement buys the same protection at the cost of a schema the author has
 * to learn. The driver asks instead.
 *
 * `only` exists for the scenarios that genuinely are provider-specific: a Claude Code harness
 * walk is meaningless on LM Studio, and RFC-0011's walk names ToolSearch rows by name.
 *
 * A live scenario must **not** name frames, and that is a rejection rather than an ignored key.
 * The scripted client's rounds cursor is meaningless when a real model decides how many rounds
 * there are, so a live run arms no script at all and the epilogue is never appended.
 */
function validateProvider(provider, id) {
  if (!isPlainObject(provider)) {
    fail(id, 'provider must be an object, for example { kind: "scripted", frames: "prose-turn" }');
  }
  for (const key of Object.keys(provider)) {
    if (!["kind", "frames", "only"].includes(key)) fail(id, `unknown provider key "${key}"`);
  }
  if (provider.kind === "live") return validateLiveProvider(provider, id);
  if (provider.kind !== "scripted") {
    fail(id, `provider.kind must be "scripted" or "live", not "${String(provider.kind)}"`);
  }
  if (provider.only !== undefined) {
    fail(id, "only applies to a live provider; a scripted run replays the same frames anywhere");
  }
  if (typeof provider.frames !== "string" || provider.frames.trim().length === 0) {
    fail(id, "a scripted provider needs frames naming a file under dev/driver/frames");
  }
  if (!existsSync(join(FRAMES, `${provider.frames}.json`))) {
    fail(id, `frames "${provider.frames}" has no file at dev/driver/frames/${provider.frames}.json`);
  }
  return { kind: provider.kind, frames: provider.frames, only: null };
}

/**
 * Provider keys a live scenario may pin.
 *
 * `PROVIDER_OPTIONS` in `src/shared/modelKeys.ts` is the source of truth; this is a copy, because
 * the driver is plain ESM outside the typechecked tree and cannot import it. A new provider adds
 * a line here. The duplication is deliberate and small: checking `only` in Node is what keeps a
 * typo from costing a real Obsidian launch to discover, which is the rule the fixture and frame
 * checks above already follow.
 */
const LIVE_PROVIDERS = ["lmstudio", "anthropic", "openai", "claudecode"];

function validateLiveProvider(provider, id) {
  if (provider.frames !== undefined) {
    fail(
      id,
      "a live provider takes no frames: a real model decides how many rounds a turn has, so a " +
        "live run arms no script and installs the release build untouched",
    );
  }
  if (provider.only !== undefined && !LIVE_PROVIDERS.includes(provider.only)) {
    fail(id, `provider.only must be one of ${LIVE_PROVIDERS.join(", ")}, not "${String(provider.only)}"`);
  }
  return { kind: "live", frames: null, only: provider.only ?? null };
}

export async function loadScenario(id) {
  const module = await import(`../scenarios/${id}.mjs`);
  return validateScenario(module.default, id);
}

/** Every scenario on disk, loaded and validated, so a typo in one fails before a launch. */
export async function loadScenarios() {
  const scenarios = [];
  for (const id of listScenarioIds()) scenarios.push(await loadScenario(id));
  return scenarios;
}

/**
 * The scenario list, grouped by what choosing one costs you.
 *
 * Simulated first, because that is where most defects are found and none of it spends anything.
 * Live second, marked as a group rather than by a prefix inside a description: "this one costs real
 * tokens" is not something a reader should have to notice in prose. The instrument's own alarms
 * last, because they are meant to fail and should not be entries 1 and 2 that somebody picks by
 * accident.
 *
 * The sweep is an entry in this list rather than a flag, for the same reason the matrix is an entry
 * in the model list: a mode that only exists as a flag is a mode nobody finds.
 */
export async function scenarioMenu(scenarios = null) {
  const all = scenarios ?? (await loadScenarios());
  const simulated = all.filter((one) => one.provider.kind !== "live" && !one.mustFail);
  const live = all.filter((one) => one.provider.kind === "live");
  const alarms = all.filter((one) => one.mustFail);
  const entry = (scenario, group) => ({
    label: scenario.id,
    detail: scenario.description,
    group,
    value: { scenario: scenario.id, suite: null },
  });

  return [
    {
      group: "everything at once",
      label: "sweep the scenarios",
      detail: `${simulated.length} runs in series, one directory each, no tokens spent`,
      value: { scenario: null, suite: "simulated" },
    },
    {
      group: "everything at once",
      label: "sweep the instrument's own alarms",
      detail: `${alarms.length} runs that must fail. run this after changing the driver.`,
      value: { scenario: null, suite: "alarms" },
    },
    ...simulated.map((one) =>
      entry(one, "simulated, authored frames. free, repeatable, and where most defects turn up"),
    ),
    ...live.map((one) =>
      entry(one, "live, a real provider. real tokens or a real local model, and not repeatable"),
    ),
    ...alarms.map((one) =>
      entry(one, "the instrument's own alarms. these are meant to fail, and a sweep includes them"),
    ),
  ];
}

/**
 * Which scenarios a named sweep covers.
 *
 * Two sweeps, not one, and the split is the maintainer's: the instrument's own alarms are meant to
 * fail, and a sweep run to look for defects in the *application* should not spend two of its eleven
 * launches, and two of its breakpoints under pause mode, on runs whose failure means nothing is
 * wrong. They keep their own entry rather than being deleted, because the question they ask ("does
 * this still notice a missed click") is worth asking after any change to the driver, and a check
 * nobody can find in a list is a check nobody runs.
 *
 * What that trades away is stated rather than hidden: a scenario sweep no longer re-checks the
 * instrument, so its sheet says so and names the sweep that does.
 */
const SUITES = {
  simulated: (one) => one.provider.kind !== "live" && !one.mustFail,
  alarms: (one) => one.provider.kind !== "live" && one.mustFail,
};

export async function suiteScenarios(suite, scenarios = null) {
  const covers = SUITES[suite];
  if (!covers) throw new Error(`There is no "${suite}" sweep.`);
  const covered = (scenarios ?? (await loadScenarios())).filter(covers);
  if (covered.length === 0) throw new Error(`The "${suite}" sweep covers no scenarios.`);
  return covered;
}

/** What a sweep deliberately did not run, for the sheet to say out loud. */
export function suiteOmission(suite) {
  return suite === "simulated"
    ? "the instrument's own alarms were not run. \"sweep the instrument's own alarms\" runs those."
    : null;
}

/**
 * A scenario's settings over the fixture's committed baseline.
 *
 * What breaks without it: every settings variation costs a whole new fixture vault directory,
 * and the fixture tree is already the thing most likely to accrete past anyone's understanding.
 * Objects merge so a scenario can flip one provider's `enabled` without restating the map;
 * arrays and scalars replace, because a scenario overriding a list means that list.
 */
export function mergeSettings(base, patch) {
  if (!isPlainObject(patch)) return base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] =
      isPlainObject(value) && isPlainObject(base?.[key]) ? mergeSettings(base[key], value) : value;
  }
  return merged;
}

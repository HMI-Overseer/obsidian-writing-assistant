// What a live run boots on (RFC-0013 Stage 3, plan section 6).
//
// A scripted run needs no credentials by construction: the fixture seeds a custom entry under a
// cloud provider with a placeholder key, and nothing reaches the provider because the scripted
// client is installed at the `createChatClient` seam. A live run has to authenticate as somebody.
//
// It authenticates as the maintainer, by reading the installed plugin's own `data.json`. This
// repository *is* the installed plugin, so that file is on disk beside the build the driver
// installs, it is gitignored, and it is already the answer to "which providers are configured on
// this machine". The alternative is a second copy of a secret in a second place, which is worse
// on every axis.
//
// Since ADR-0039 that is no longer true of the keyed cloud providers, and it is worth being precise
// about what changed: `data.json` now carries a secret *id*, and the credential itself lives in
// Obsidian's secret storage, which the scratch profile cannot reach. So a live run against Anthropic
// or OpenAI fails with a message that says what to do instead, see
// `assertLiveCredentialsReachable`. This is the feature working rather than a regression to fix: a
// disposable vault should never have held real credentials. LM Studio and Claude Code need no key,
// which is the bulk of what live mode is for, and a hand-linked key in the scratch profile covers
// the rest.
//
// One consequence remains, stated rather than discovered: the run directory holds no credential.
// The manifest records that provider settings came from the installed plugin, never the patch
// itself, because a run directory is the artifact a person re-reads and may share, and the scenario
// `settings` it *does* record are authored and public.
//
// What is copied is the smallest set that answers "which models can I pick, and can I send to
// one": enablement and credentials, the custom entries and last-seen caches that feed
// `getSelectableCompletionModels()`, and the capability caches the reasoning selector reads.
// Everything else (conversations, RAG, memories, vault-op policy, posture) stays the fixture's,
// because those are what a scenario is about and a run must not inherit them from whatever state
// the maintainer's own vault happens to be in.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const INSTALLED_SETTINGS = join(REPO, "data.json");

/**
 * Provider configuration and the model caches behind it, out of the installed plugin's settings.
 *
 * `lmStudioModelCache` is copied even though the bridge refreshes discovery before it asks: the
 * copy is what the app *boots* holding, so the first render of the model list is the maintainer's
 * own last-seen state rather than an empty one. Whether a cached model is still loaded is exactly
 * what the reachability preflight then decides.
 */
export function readLiveProviderSettings(path = INSTALLED_SETTINGS) {
  if (!existsSync(path)) {
    throw new Error(
      `Live mode needs the installed plugin's settings, and there is no ${path}. ` +
        `Open the plugin in this vault and configure a provider first, or run a scripted scenario.`,
    );
  }

  let settings;
  try {
    settings = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Live mode could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!settings.providerSettings || typeof settings.providerSettings !== "object") {
    throw new Error(`${path} carries no providerSettings, so no live provider can be reached.`);
  }

  return {
    // The disclaimer gate is a settings gate, not a credential: an unaccepted one makes the whole
    // plugin inert, which is the fixture's baseline answer too.
    apiKeysDisclaimerAccepted: true,
    providerSettings: settings.providerSettings,
    customModels: settings.customModels ?? {},
    modelIdAliases: settings.modelIdAliases ?? {},
    lmStudioModelCache: settings.lmStudioModelCache ?? {
      completion: [],
      embedding: [],
      discoveredAt: null,
    },
    claudeCodeEffortLevels: settings.claudeCodeEffortLevels ?? {},
    reasoningByModelKey: settings.reasoningByModelKey ?? {},
    // The dropdown lands on favorites whenever any favorite is selectable, which would put the
    // driver's provider rail click somewhere it did not ask for. A live run starts from the
    // provider categories, which is what its own question is phrased in.
    favoriteModelKeys: [],
  };
}

/** Which providers the installed settings have switched on, for a plain "nothing to run" reason. */
export function enabledLiveProviders(patch) {
  return Object.entries(patch.providerSettings)
    .filter(([, value]) => value?.enabled === true)
    .map(([provider]) => provider);
}

/** Providers that authenticate with a credential we hold. Mirrors `KeyedProvider` in src. */
const KEYED_PROVIDERS = ["anthropic", "openai"];

/**
 * Whether a keyed provider's credential can still reach the scratch profile. It cannot, and this
 * says so out loud rather than letting a run discover it as a provider 401.
 *
 * Since ADR-0039 the installed plugin's `data.json` carries a secret **id**, not a key; the value
 * lives in Obsidian's secret storage. That store is per Electron profile (it persists through
 * `app.saveLocalStorage`, and the driver launches with `--user-data-dir` pointed at a scratch
 * profile under the OS temp directory) and additionally keyed per vault by `appId`. So the scratch
 * profile provably cannot read the real vault's secrets, by two independent mechanisms.
 *
 * This is the feature working: a disposable vault should never have held real credentials, and the
 * driver exists to jump-start testing, which LM Studio and Claude Code do without a key. What is
 * owed here is one clear message, not a way to copy the secret across.
 */
export function assertLiveCredentialsReachable(patch, provider) {
  if (!KEYED_PROVIDERS.includes(provider)) return;
  throw new Error(
    `Live mode cannot inherit the ${provider} API key. Since ADR-0039 the installed plugin stores ` +
      `only a secret id in data.json and the key itself lives in Obsidian's secret storage, which ` +
      `is per Electron profile and per vault. The driver runs in a scratch profile, so it cannot ` +
      `read it, and copying it there would put a real credential back into a disposable vault.\n` +
      `Either link a key by hand in the scratch profile's Providers tab, or run this scenario ` +
      `against LM Studio or Claude Code, which need no key.`,
  );
}

export const INSTALLED_SETTINGS_PATH = INSTALLED_SETTINGS;

// Live mode's model question, its reachability preflight, and the two clicks that select one
// (RFC-0013 "Model selection", plan section 6).
//
// Three rules shape all of it, and each is somebody's settled decision rather than a preference:
//
//   The list comes from the running app. `selectableModels()` reaches the chat selector's own
//   `getModels` closure, so the driver reads through `getSelectableCompletionModels()` like every
//   other consumer of "what models can I pick". Composing a second answer here from settings
//   would make provider enablement advisory, which is the invariant that module states.
//
//   A model is checked before the walk, not during it. LM Studio's catalog is a last-seen cache,
//   so a model can be selectable and not loaded, and the failure would otherwise surface mid-walk
//   as a confusing half-run whose real cause is that the model was absent. This is the
//   checkpoint-arrival rule applied one step earlier: fail at the point of truth rather than
//   produce plausible evidence of the wrong thing.
//
//   The model is chosen through the real UI. Setting it through the bridge would be the bridge
//   changing the application under test, and the selector is a chat surface like any other: the
//   rail, the search field, and the row are real clicks and real keystrokes.

import {
  MODEL_DROPDOWN_SEARCH,
  MODEL_SELECTOR,
  modelDropdownRow,
  modelRailEntry,
} from "./scenarioApi.mjs";

/**
 * Whether a model can actually be sent to, and a plain reason when it cannot.
 *
 * The honest limit, stated where it is decided: a cloud model reports reachable without any
 * network call, because `ModelAvailabilityService.getAvailability` short-circuits every cloud
 * provider. So a wrong or expired key still surfaces mid-turn. The case this preflight exists for
 * is the local one, where "selectable" and "loaded" are genuinely different facts.
 */
export function reachability(model, discoveryError = null) {
  if (model.state === "cloud") return { ok: true, reason: "cloud, no local load required" };
  if (model.state === "loaded") return { ok: true, reason: "loaded" };
  if (model.state === "unloaded") {
    return {
      ok: false,
      reason:
        `${model.modelId} is in LM Studio's catalog but is not loaded. Load it in LM Studio, ` +
        `or pick a model that is.`,
    };
  }
  return {
    ok: false,
    reason:
      `${model.modelId} was not reported by discovery, so nothing knows whether it can be ` +
      `reached.${discoveryError ? ` Discovery failed: ${discoveryError}` : ""}`,
  };
}

/** The short right-hand line in the model list: state first, then what the app discovered. */
export function describeModel(model) {
  const parts = [model.state === "cloud" ? "cloud" : model.state.replace("unloaded", "not loaded")];
  if (model.trainedForToolUse === true) parts.push("tools");
  if (model.trainedForToolUse === false) parts.push("no tool training");
  if (model.vision === true) parts.push("vision");
  if (Array.isArray(model.reasoning) && model.reasoning.length > 0) parts.push("reasoning");
  if (typeof model.contextWindow === "number") {
    parts.push(model.contextWindow >= 1000 ? `${Math.round(model.contextWindow / 1000)}k` : `${model.contextWindow}`);
  }
  return parts.join(", ");
}

function byProvider(models) {
  const grouped = new Map();
  for (const model of models) {
    if (!grouped.has(model.provider)) grouped.set(model.provider, []);
    grouped.get(model.provider).push(model);
  }
  return grouped;
}

/**
 * The provider and model questions, asked of the running app's own answer.
 *
 * The matrix is an entry in the model list rather than a flag, so running a scenario across every
 * model of a provider is discoverable by somebody who never reads the flags. It covers the models
 * that pass the preflight and says how many it is leaving out, because a matrix that silently
 * dropped a model would read as "this model was judged and did badly".
 */
export async function askLiveModel(terminal, { models, discoveryError }, only) {
  const offered = only ? models.filter((model) => model.provider === only) : models;
  if (offered.length === 0) {
    throw new Error(
      `No selectable models${only ? ` for ${only}` : ""}. The app offers ` +
        `${models.length === 0 ? "none at all" : models.map((model) => model.key).join(", ")}. ` +
        `Live mode boots on the installed plugin's provider settings, so enable the provider ` +
        `there.${discoveryError ? ` LM Studio discovery also failed: ${discoveryError}` : ""}`,
    );
  }

  const grouped = byProvider(offered);
  const provider = await terminal.choose(
    "provider",
    [...grouped.entries()].map(([key, list]) => {
      const reachable = list.filter((model) => reachability(model, discoveryError).ok).length;
      return {
        label: key,
        detail: `${list.length} ${list.length === 1 ? "model" : "models"}, ${reachable} reachable`,
        value: key,
      };
    }),
  );

  const list = grouped.get(provider);
  const reachable = list.filter((model) => reachability(model, discoveryError).ok);
  const skipped = list.filter((model) => !reachability(model, discoveryError).ok);
  const options = [];
  if (reachable.length > 1) {
    options.push({
      label: `all ${reachable.length} reachable models from ${provider}, as a matrix`,
      detail: skipped.length > 0 ? `${skipped.length} skipped, not reachable` : "one run each",
      value: { matrix: true },
    });
  }
  for (const model of list) {
    const check = reachability(model, discoveryError);
    options.push({
      label: model.modelId,
      detail: check.ok ? describeModel(model) : `${describeModel(model)}, fails the preflight`,
      value: { matrix: false, model },
    });
  }

  const chosen = await terminal.choose("model", options);
  return chosen.matrix
    ? { provider, matrix: true, models: reachable, skipped }
    : { provider, matrix: false, models: [chosen.model], skipped: [] };
}

/**
 * The run's own reachability check, against the app that will do the walk.
 *
 * The picker's answer came from a different launch and may be minutes old, so this is the one
 * that gates. It also resolves the model key to what the app currently reports, which is what the
 * manifest records: a run states what executed, not what was asked for.
 */
export function preflight({ models, discoveryError }, key) {
  const model = models.find((entry) => entry.key === key);
  if (!model) {
    throw new Error(
      `The app no longer offers ${key}. It offers ${
        models.length === 0 ? "nothing" : models.map((entry) => entry.key).join(", ")
      }.${discoveryError ? ` Discovery failed: ${discoveryError}` : ""}`,
    );
  }
  const check = reachability(model, discoveryError);
  if (!check.ok) throw new Error(`${key} cannot be reached. ${check.reason}`);
  return model;
}

/**
 * Selects a model the way a person does: open the selector, land on the provider, search, click.
 *
 * Every step goes through the scenario API, so all four land in the run's ledger and a selector
 * that has drifted fails the run naming what it could not click, in the same shape as any missed
 * click inside a scenario.
 *
 * The row is matched on the display name the app itself reported, never on a name invented here,
 * and it is required to be unique: Playwright's `click` takes the first of an ambiguous match
 * silently, which would read as "this model was selected" while a different one was.
 */
export async function selectModelInUi(api, model) {
  await api.click(MODEL_SELECTOR);
  await api.click(modelRailEntry(model.provider));
  await api.click(MODEL_DROPDOWN_SEARCH);
  await api.type(model.modelId);

  const row = modelDropdownRow(model.name);
  const matches = await api.page.locator(row).count();
  if (matches !== 1) {
    throw new Error(
      `The model list shows ${matches} rows named "${model.name}" after searching for ` +
        `${model.modelId}, and a click would have taken the first one silently.`,
    );
  }
  await api.click(row);

  const resolved = (await api.state()).model;
  if (resolved?.key !== model.key) {
    throw new Error(
      `The app resolved ${resolved?.key ?? "no model"} after selecting ${model.key}. ` +
        `A run records what executed, so it stops here rather than walking under the wrong label.`,
    );
  }
  return resolved;
}

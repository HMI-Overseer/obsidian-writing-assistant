// Pure, IO-free helpers for the build-time Anthropic pricing sync. The IO
// (network fetch, retry, filesystem) lives in update-pricing.mjs; everything
// here is deterministic and unit-tested in tests/unit/scripts/pricingSync.test.ts.
//
// Source of truth at runtime is the committed src/api/pricingData.json. This
// sync only refreshes the *live frontier* models below; the retired/Glasswing
// tail stays hardcoded in src/api/pricing.ts (those prices are frozen).

/**
 * Plugin model id -> OpenRouter model id slug. OpenRouter uses dot versions
 * (`claude-opus-4.8`); the plugin and Anthropic API use dashes (`claude-opus-4-8`).
 * Add a row here to start tracking a new model's live price.
 */
export const TRACKED_MODELS = {
  "claude-opus-4-8": "anthropic/claude-opus-4.8",
  "claude-opus-4-7": "anthropic/claude-opus-4.7",
  "claude-opus-4-6": "anthropic/claude-opus-4.6",
  "claude-sonnet-4-6": "anthropic/claude-sonnet-4.6",
  "claude-haiku-4-5": "anthropic/claude-haiku-4.5",
  "claude-fable-5": "anthropic/claude-fable-5",
};

/** Fail the sync if any tracked price moves more than this in a single run. */
export const MAX_SINGLE_STEP_MOVE = 0.5;

const PRICE_FIELDS = ["input", "output", "cacheWrite", "cacheRead"];

/** Per-token decimal string -> USD per million tokens, rounded to 4 dp. */
export function perMillion(perToken) {
  const n = Number(perToken);
  if (!Number.isFinite(n)) throw new Error(`non-numeric price: ${perToken}`);
  return Math.round(n * 1e6 * 1e4) / 1e4;
}

/**
 * Build { pluginId: {input, output, cacheWrite, cacheRead} } (USD per MTok) from
 * an OpenRouter `/api/v1/models` payload. Throws if a tracked model is absent
 * upstream, so a renamed/dropped model fails loudly instead of silently freezing.
 */
export function extractModels(payload, tracked = TRACKED_MODELS) {
  const byId = new Map((payload?.data ?? []).map((m) => [m.id, m]));
  const out = {};
  for (const [pluginId, slug] of Object.entries(tracked)) {
    const entry = byId.get(slug);
    if (!entry || !entry.pricing) throw new Error(`missing upstream model: ${slug}`);
    const p = entry.pricing;
    out[pluginId] = {
      input: perMillion(p.prompt),
      output: perMillion(p.completion),
      cacheWrite: perMillion(p.input_cache_write),
      cacheRead: perMillion(p.input_cache_read),
    };
  }
  return out;
}

/**
 * Guard against a bad upstream reading. Always rejects a non-positive price.
 * Rejects a single-step move larger than {@link MAX_SINGLE_STEP_MOVE} (a real
 * repricing that big should get a human glance) unless `allowLargeMoves` is set.
 */
export function assertSane(next, prev = {}, { allowLargeMoves = false } = {}) {
  for (const [id, price] of Object.entries(next)) {
    for (const field of PRICE_FIELDS) {
      const value = price[field];
      if (!(value > 0)) throw new Error(`${id}.${field} is not > 0 (got ${value})`);
      const before = prev?.[id]?.[field];
      if (before > 0 && !allowLargeMoves) {
        const move = Math.abs(value - before) / before;
        if (move > MAX_SINGLE_STEP_MOVE) {
          throw new Error(
            `${id}.${field} moved ${(move * 100).toFixed(0)}% (${before} -> ${value}), ` +
              `over the ${MAX_SINGLE_STEP_MOVE * 100}% guard`
          );
        }
      }
    }
  }
}

/** Value-equality of two { id: {input,output,cacheWrite,cacheRead} } maps. */
export function modelsEqual(a, b) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((id) => PRICE_FIELDS.every((f) => a[id][f] === b[id][f]));
}

/** Deterministic JSON text for the data file (sorted keys, trailing newline). */
export function renderDataFile(asOf, models, source) {
  const sorted = {};
  for (const id of Object.keys(models).sort()) {
    const p = models[id];
    sorted[id] = { input: p.input, output: p.output, cacheWrite: p.cacheWrite, cacheRead: p.cacheRead };
  }
  return JSON.stringify({ asOf, source, models: sorted }, null, 2) + "\n";
}

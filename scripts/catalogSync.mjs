// Pure, IO-free helpers for the build-time cloud model catalog sync. Rides the
// same OpenRouter fetch as the pricing sync (update-pricing.mjs, ADR-0007
// pattern) and regenerates src/providers/catalogData.json alongside
// pricingData.json. Deterministic and unit-tested in
// tests/unit/scripts/catalogSync.test.ts.
//
// Two staleness modes split cleanly:
//   - Attribute staleness (context bumps, capability changes): refreshed every
//     release with no human step.
//   - New-model staleness: the per-provider patterns below AUTO-INCLUDE new
//     matches (a brand-new family whose ids still match `claude-*` ships in
//     the next release with no hand edit). The shape guard plus the visible
//     catalogData.json diff in the version commit are the review.

/**
 * Which upstream slugs belong to which provider card. Variant slugs
 * (`:free`, `:beta`, `:extended`, ...) are routing aliases, not models the
 * plugin can address through the provider's own API, so they are skipped.
 */
export const PROVIDER_PATTERNS = {
  anthropic: /^anthropic\/claude-/,
  openai: /^openai\/(gpt-|o\d)/,
};

/**
 * Feed entries that match a provider pattern but do not belong in the plugin's
 * chat catalog:
 *   - `-fast` is OpenRouter's routing alias for Anthropic fast mode, which the
 *     first-party API selects via a request parameter, not a model id; the id
 *     would 400 if sent to Anthropic directly.
 *   - Dated OpenAI snapshots (`gpt-4o-2024-05-13`) duplicate their bare alias,
 *     and `-latest` aliases drift under the same id.
 *   - `gpt-oss-*` are open-weight releases OpenRouter hosts under the openai
 *     prefix; api.openai.com does not serve them.
 *   - Audio / image / search-preview / deep-research specializations are not
 *     usable through the plugin's chat surface.
 *   - The superseded gpt-3.5 / gpt-4-base families stay out; anything newer
 *     auto-includes. A user who still wants an excluded id has the card's
 *     custom-model escape hatch.
 */
export const EXCLUDED_MODEL_IDS = {
  anthropic: /-fast$/,
  openai:
    /-\d{4}-\d{2}-\d{2}$|-latest$|^gpt-3\.5|^gpt-4(-|$)|^gpt-oss|audio|image|-search-preview$|-deep-research$/,
};

/**
 * Entries no feed carries. OpenRouter is a chat router, so OpenAI's embedding
 * models are seeded here; Claude Code selects models by CLI alias, not by API
 * id, so its catalog is fixed.
 */
export const STATIC_CATALOG_ENTRIES = {
  openai: [
    { modelId: "text-embedding-3-large", name: "Text Embedding 3 Large", role: "embedding", contextWindowSize: 8191 },
    { modelId: "text-embedding-3-small", name: "Text Embedding 3 Small", role: "embedding", contextWindowSize: 8191 },
  ],
  claudecode: [
    { modelId: "fable", name: "Fable (Claude Code)", role: "completion" },
    { modelId: "haiku", name: "Haiku (Claude Code)", role: "completion" },
    { modelId: "opus", name: "Opus (Claude Code)", role: "completion" },
    { modelId: "sonnet", name: "Sonnet (Claude Code)", role: "completion" },
  ],
};

/** OpenRouter slug -> the provider's native model id. */
export function toNativeModelId(provider, slug) {
  const bare = slug.slice(slug.indexOf("/") + 1);
  // OpenRouter uses dot versions for Anthropic (`claude-opus-4.8`); the
  // Anthropic API uses dashes. OpenAI ids keep their dots (`gpt-5.1`).
  return provider === "anthropic" ? bare.replaceAll(".", "-") : bare;
}

/** "Anthropic: Claude Opus 4.8" -> "Claude Opus 4.8". */
export function toDisplayName(feedName, fallback) {
  if (typeof feedName !== "string" || feedName.length === 0) return fallback;
  const separator = feedName.indexOf(": ");
  return separator > 0 ? feedName.slice(separator + 2) : feedName;
}

/**
 * Build { provider: CatalogEntry[] } from an OpenRouter `/api/v1/models`
 * payload: feed matches per PROVIDER_PATTERNS plus the static seeds. Entries
 * are sorted by modelId (then role) so output is deterministic.
 */
export function extractCatalog(payload, patterns = PROVIDER_PATTERNS) {
  const providers = {};
  for (const [provider, pattern] of Object.entries(patterns)) {
    const entries = new Map();
    for (const model of payload?.data ?? []) {
      if (typeof model?.id !== "string") continue;
      if (model.id.includes(":")) continue; // variant slug, not a model
      if (!pattern.test(model.id)) continue;
      const modelId = toNativeModelId(provider, model.id);
      if (EXCLUDED_MODEL_IDS[provider]?.test(modelId)) continue;
      if (entries.has(modelId)) continue;
      const contextWindowSize = Number(model.context_length);
      const modalities = model.architecture?.input_modalities;
      const entry = {
        modelId,
        name: toDisplayName(model.name, modelId),
        role: "completion",
        ...(Number.isFinite(contextWindowSize) && contextWindowSize > 0
          ? { contextWindowSize }
          : {}),
        ...(Array.isArray(modalities) ? { vision: modalities.includes("image") } : {}),
      };
      entries.set(modelId, entry);
    }
    providers[provider] = [...entries.values()];
  }
  for (const [provider, statics] of Object.entries(STATIC_CATALOG_ENTRIES)) {
    providers[provider] = [...(providers[provider] ?? []), ...statics];
  }
  for (const provider of Object.keys(providers)) {
    providers[provider].sort(
      (a, b) => a.modelId.localeCompare(b.modelId) || a.role.localeCompare(b.role),
    );
  }
  return providers;
}

const VALID_ROLES = new Set(["completion", "embedding"]);

/**
 * Shape guard mirroring the pricing sync's >50%-move guard: a garbage upstream
 * entry (or a pattern that suddenly matches nothing) fails the version bump
 * for a human glance instead of shipping a broken catalog.
 */
export function assertCatalogSane(providers) {
  for (const provider of ["anthropic", "openai", "claudecode"]) {
    const entries = providers[provider];
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error(`${provider} catalog is empty`);
    }
    if (!entries.some((entry) => entry.role === "completion")) {
      throw new Error(`${provider} catalog has no completion models`);
    }
    for (const entry of entries) {
      if (typeof entry.modelId !== "string" || entry.modelId.length === 0) {
        throw new Error(`${provider} catalog entry with empty modelId`);
      }
      if (typeof entry.name !== "string" || entry.name.length === 0) {
        throw new Error(`${provider}/${entry.modelId} has an empty name`);
      }
      if (!VALID_ROLES.has(entry.role)) {
        throw new Error(`${provider}/${entry.modelId} has invalid role ${entry.role}`);
      }
      if (entry.contextWindowSize !== undefined && !(entry.contextWindowSize >= 1000)) {
        throw new Error(
          `${provider}/${entry.modelId} has implausible context ${entry.contextWindowSize}`,
        );
      }
    }
  }
  if (!providers.anthropic.some((entry) => entry.modelId.startsWith("claude-"))) {
    throw new Error("anthropic catalog lost every claude-* id");
  }
}

/** Value-equality of two { provider: CatalogEntry[] } maps. */
export function catalogsEqual(a, b) {
  return JSON.stringify(sortedProviders(a)) === JSON.stringify(sortedProviders(b));
}

function sortedProviders(providers) {
  const sorted = {};
  for (const provider of Object.keys(providers).sort()) {
    sorted[provider] = providers[provider].map((entry) => ({
      modelId: entry.modelId,
      name: entry.name,
      role: entry.role,
      ...(entry.contextWindowSize !== undefined
        ? { contextWindowSize: entry.contextWindowSize }
        : {}),
      ...(entry.vision !== undefined ? { vision: entry.vision } : {}),
    }));
  }
  return sorted;
}

/** Deterministic JSON text for the data file (sorted keys, trailing newline). */
export function renderCatalogFile(asOf, providers, source) {
  return JSON.stringify({ asOf, source, providers: sortedProviders(providers) }, null, 2) + "\n";
}

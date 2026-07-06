// Build-time pricing + model-catalog refresh (ADR-0007). Run by the `version`
// npm script (i.e. on every `npm version <patch|minor|major>`), so each release
// bakes in current Anthropic pricing AND current cloud model catalogs. The
// plugin itself never fetches anything at runtime: this writes the committed
// src/api/pricingData.json and src/providers/catalogData.json, which the
// bundle reads.
//
// Behaviour (shared by both outputs, one fetch):
//   - Fetch OpenRouter's model list (with retry). On total failure, keep the
//     committed files and exit 0, so an offline/flaky release still builds with
//     last-known data.
//   - Sanity-check the results (pricing: no zero/negative prices, no >50%
//     single-step move unless PRICING_SYNC_ALLOW_LARGE_MOVES=1; catalog: shape
//     guard in catalogSync.mjs). On anomaly, exit 1 to fail the version bump so
//     a human looks.
//   - Only rewrite a file when its data actually changed, so an unchanged run
//     leaves it byte-identical and `git add` stages nothing.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  TRACKED_MODELS,
  extractModels,
  assertSane,
  modelsEqual,
  renderDataFile,
} from "./pricingSync.mjs";
import {
  extractCatalog,
  assertCatalogSane,
  catalogsEqual,
  renderCatalogFile,
} from "./catalogSync.mjs";

const SOURCE = "https://openrouter.ai/api/v1/models";
const RETRIES = 3;
const TIMEOUT_MS = 20_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(HERE, "..", "src", "api", "pricingData.json");
const CATALOG_PATH = join(HERE, "..", "src", "providers", "catalogData.json");

async function fetchWithRetry(url, attempts) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { accept: "application/json" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      lastError = error;
      console.warn(`[update-pricing] fetch attempt ${attempt}/${attempts} failed: ${error.message}`);
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
      }
    }
  }
  throw lastError ?? new Error("fetch failed");
}

function readExisting() {
  if (!existsSync(DATA_PATH)) return { asOf: null, models: {} };
  return JSON.parse(readFileSync(DATA_PATH, "utf8"));
}

function readExistingCatalog() {
  if (!existsSync(CATALOG_PATH)) return { asOf: null, providers: {} };
  return JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const existing = readExisting();

  let payload;
  try {
    payload = await fetchWithRetry(SOURCE, RETRIES);
  } catch (error) {
    console.warn(
      `[update-pricing] all ${RETRIES} attempts failed (${error.message}); ` +
        `keeping committed pricing (as of ${existing.asOf ?? "unknown"}).`
    );
    return 0;
  }

  let next;
  try {
    next = extractModels(payload, TRACKED_MODELS);
    assertSane(next, existing.models, {
      allowLargeMoves: process.env.PRICING_SYNC_ALLOW_LARGE_MOVES === "1",
    });
  } catch (error) {
    console.error(`[update-pricing] ${error.message}`);
    if (/moved \d+%/.test(error.message)) {
      console.error("[update-pricing] If this change is real, re-run with PRICING_SYNC_ALLOW_LARGE_MOVES=1");
    }
    return 1;
  }

  if (modelsEqual(next, existing.models)) {
    console.log("[update-pricing] pricing unchanged; leaving pricingData.json untouched.");
  } else {
    writeFileSync(DATA_PATH, renderDataFile(today(), next, SOURCE));
    console.log(`[update-pricing] pricing updated (as of ${today()}).`);
  }

  // ── Model catalog (same payload, second output) ──
  const existingCatalog = readExistingCatalog();
  let nextCatalog;
  try {
    nextCatalog = extractCatalog(payload);
    assertCatalogSane(nextCatalog);
  } catch (error) {
    console.error(`[update-pricing] catalog: ${error.message}`);
    return 1;
  }

  if (catalogsEqual(nextCatalog, existingCatalog.providers ?? {})) {
    console.log("[update-pricing] catalog unchanged; leaving catalogData.json untouched.");
    return 0;
  }

  writeFileSync(CATALOG_PATH, renderCatalogFile(today(), nextCatalog, SOURCE));
  console.log(`[update-pricing] model catalog updated (as of ${today()}).`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`[update-pricing] unexpected error: ${error?.stack ?? error}`);
    process.exit(1);
  });

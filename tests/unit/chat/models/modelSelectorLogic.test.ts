import { describe, it, expect } from "vitest";
import type { CompletionModel, ProviderOption } from "../../../../src/shared/types";
import {
  filterModelsByQuery,
  isFavoriteModel,
  modelsForCategory,
  resolveLandingCategory,
} from "../../../../src/chat/models/modelSelectorLogic";

function model(provider: ProviderOption, modelId: string, name?: string): CompletionModel {
  return {
    id: `${provider}:${modelId}`,
    name: name ?? modelId,
    modelId,
    provider,
  };
}

const fable = model("anthropic", "claude-fable-5", "Claude Fable 5");
const opus = model("anthropic", "claude-opus-4-8", "Claude Opus 4.8");
const haiku = model("anthropic", "claude-haiku-4-5", "Claude Haiku 4.5");
const qwen = model("lmstudio", "qwen3-8b", "Qwen3 8B");
const gpt = model("openai", "gpt-5.2", "GPT-5.2");

// Composed order: lmstudio first, then anthropic, then openai (PROVIDER_OPTIONS order).
const ALL = [qwen, fable, opus, haiku, gpt];

describe("isFavoriteModel", () => {
  it("matches on the composed provider:modelId key", () => {
    expect(isFavoriteModel(fable, ["anthropic:claude-fable-5"])).toBe(true);
    // A bare modelId is not a composed key and must not match.
    expect(isFavoriteModel(fable, ["claude-fable-5"])).toBe(false);
  });
});

describe("modelsForCategory", () => {
  it("favorites is the selectable set filtered by key membership, in list order", () => {
    const favorites = ["openai:gpt-5.2", "lmstudio:qwen3-8b"];
    expect(modelsForCategory(ALL, "favorites", favorites)).toEqual([qwen, gpt]);
  });

  it("a stale favorite key (provider disabled, model vanished) simply doesn't render", () => {
    const favorites = ["openai:gpt-5.2", "anthropic:claude-fable-5"];
    const withoutOpenAI = ALL.filter((m) => m.provider !== "openai");
    expect(modelsForCategory(withoutOpenAI, "favorites", favorites)).toEqual([fable]);
  });

  it("a provider category floats starred models to the top, catalog order within groups", () => {
    const favorites = ["anthropic:claude-haiku-4-5"];
    expect(modelsForCategory(ALL, "anthropic", favorites)).toEqual([haiku, fable, opus]);
  });

  it("a provider category excludes other providers' models", () => {
    expect(modelsForCategory(ALL, "lmstudio", [])).toEqual([qwen]);
  });
});

describe("filterModelsByQuery", () => {
  it("returns everything for an empty or whitespace query", () => {
    expect(filterModelsByQuery(ALL, "")).toEqual(ALL);
    expect(filterModelsByQuery(ALL, "   ")).toEqual(ALL);
  });

  it("matches case-insensitive substrings of the display name", () => {
    expect(filterModelsByQuery(ALL, "OPUS")).toEqual([opus]);
  });

  it("matches on modelId when the display name doesn't contain the query", () => {
    expect(filterModelsByQuery(ALL, "gpt-5")).toEqual([gpt]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterModelsByQuery(ALL, "mistral")).toEqual([]);
  });
});

describe("resolveLandingCategory", () => {
  const enabled: ProviderOption[] = ["lmstudio", "anthropic", "openai"];

  it("lands on favorites when any favorite is currently selectable", () => {
    const category = resolveLandingCategory(ALL, ["openai:gpt-5.2"], fable, enabled);
    expect(category).toBe("favorites");
  });

  it("skips favorites while empty and lands on the active model's provider", () => {
    const category = resolveLandingCategory(ALL, [], gpt, enabled);
    expect(category).toBe("openai");
  });

  it("skips favorites when every favorite key is stale (model no longer selectable)", () => {
    const category = resolveLandingCategory(ALL, ["notaprovider:ghost"], gpt, enabled);
    expect(category).toBe("openai");
  });

  it("falls back to the first enabled provider with models when there is no active model", () => {
    const category = resolveLandingCategory(ALL, [], null, enabled);
    expect(category).toBe("lmstudio");
  });

  it("skips an enabled provider that contributes no models", () => {
    const noLocal = ALL.filter((m) => m.provider !== "lmstudio");
    const category = resolveLandingCategory(noLocal, [], null, enabled);
    expect(category).toBe("anthropic");
  });

  it("ignores an active model whose provider is disabled", () => {
    const category = resolveLandingCategory([qwen], [], gpt, ["lmstudio"]);
    expect(category).toBe("lmstudio");
  });
});

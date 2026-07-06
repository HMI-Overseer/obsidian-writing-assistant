import { describe, it, expect } from "vitest";
import {
  extractCatalog,
  assertCatalogSane,
  catalogsEqual,
  renderCatalogFile,
  toNativeModelId,
  toDisplayName,
  STATIC_CATALOG_ENTRIES,
} from "../../../scripts/catalogSync.mjs";

function orModel(
  id: string,
  name: string,
  contextLength?: number,
  modalities?: string[],
): Record<string, unknown> {
  return {
    id,
    name,
    ...(contextLength !== undefined ? { context_length: contextLength } : {}),
    ...(modalities !== undefined ? { architecture: { input_modalities: modalities } } : {}),
  };
}

const FEED = {
  data: [
    orModel("anthropic/claude-opus-4.8", "Anthropic: Claude Opus 4.8", 1000000, ["text", "image"]),
    orModel("anthropic/claude-fable-5", "Anthropic: Claude Fable 5", 1000000, ["text", "image"]),
    orModel("anthropic/claude-opus-4.8:free", "Anthropic: Claude Opus 4.8 (free)", 1000000),
    orModel("anthropic/claude-opus-4.8-fast", "Anthropic: Claude Opus 4.8 (Fast)", 1000000),
    orModel("openai/gpt-5.1", "OpenAI: GPT-5.1", 400000, ["text", "image"]),
    orModel("openai/gpt-4o-2024-05-13", "OpenAI: GPT-4o (2024-05-13)", 128000, ["text", "image"]),
    orModel("mistralai/mistral-large", "Mistral Large", 128000),
  ],
};

describe("toNativeModelId", () => {
  it("converts anthropic dot versions to dashes", () => {
    expect(toNativeModelId("anthropic", "anthropic/claude-opus-4.8")).toBe("claude-opus-4-8");
  });

  it("keeps openai dots intact", () => {
    expect(toNativeModelId("openai", "openai/gpt-5.1")).toBe("gpt-5.1");
  });
});

describe("toDisplayName", () => {
  it("strips the provider prefix", () => {
    expect(toDisplayName("Anthropic: Claude Opus 4.8", "x")).toBe("Claude Opus 4.8");
  });

  it("falls back when the feed name is missing", () => {
    expect(toDisplayName(undefined, "claude-x")).toBe("claude-x");
  });
});

describe("extractCatalog", () => {
  it("auto-includes pattern matches and skips variants and other providers", () => {
    const catalog = extractCatalog(FEED);
    const anthropicIds = catalog.anthropic.map((entry: { modelId: string }) => entry.modelId);
    expect(anthropicIds).toContain("claude-opus-4-8");
    expect(anthropicIds).toContain("claude-fable-5");
    // No duplicate from the :free variant, no mistral leakage anywhere.
    expect(anthropicIds.filter((id: string) => id === "claude-opus-4-8")).toHaveLength(1);
    const all = Object.values(catalog).flat() as Array<{ modelId: string }>;
    expect(all.some((entry) => entry.modelId.includes("mistral"))).toBe(false);
  });

  it("excludes non-addressable and duplicate ids (-fast aliases, dated snapshots)", () => {
    const catalog = extractCatalog(FEED);
    const anthropicIds = catalog.anthropic.map((entry: { modelId: string }) => entry.modelId);
    const openaiIds = catalog.openai.map((entry: { modelId: string }) => entry.modelId);
    expect(anthropicIds).not.toContain("claude-opus-4-8-fast");
    expect(openaiIds).not.toContain("gpt-4o-2024-05-13");
    expect(openaiIds).toContain("gpt-5.1");
  });

  it("carries feed capabilities (context window, vision)", () => {
    const catalog = extractCatalog(FEED);
    const opus = catalog.anthropic.find(
      (entry: { modelId: string }) => entry.modelId === "claude-opus-4-8",
    );
    expect(opus).toMatchObject({
      name: "Claude Opus 4.8",
      role: "completion",
      contextWindowSize: 1000000,
      vision: true,
    });
  });

  it("appends the static seeds (openai embeddings, claude code aliases)", () => {
    const catalog = extractCatalog(FEED);
    expect(catalog.openai.some((entry: { role: string }) => entry.role === "embedding")).toBe(true);
    expect(catalog.claudecode).toEqual(STATIC_CATALOG_ENTRIES.claudecode);
  });
});

describe("assertCatalogSane", () => {
  it("accepts the extracted catalog", () => {
    expect(() => assertCatalogSane(extractCatalog(FEED))).not.toThrow();
  });

  it("rejects an empty provider (pattern matched nothing)", () => {
    const catalog = extractCatalog({ data: [] });
    // anthropic feed matches vanish -> only static providers remain populated
    expect(() => assertCatalogSane(catalog)).toThrow(/anthropic/);
  });

  it("rejects garbage entries", () => {
    const catalog = extractCatalog(FEED);
    catalog.anthropic.push({ modelId: "", name: "x", role: "completion" });
    expect(() => assertCatalogSane(catalog)).toThrow(/empty modelId/);
  });

  it("rejects implausible context lengths", () => {
    const catalog = extractCatalog(FEED);
    catalog.anthropic.push({ modelId: "claude-x", name: "X", role: "completion", contextWindowSize: 5 });
    expect(() => assertCatalogSane(catalog)).toThrow(/implausible context/);
  });
});

describe("catalogsEqual / renderCatalogFile", () => {
  it("is order-insensitive on provider keys and byte-stable on render", () => {
    const a = extractCatalog(FEED);
    const b = JSON.parse(JSON.stringify(a));
    expect(catalogsEqual(a, b)).toBe(true);
    const rendered = renderCatalogFile("2026-07-06", a, "test");
    expect(rendered.endsWith("\n")).toBe(true);
    expect(renderCatalogFile("2026-07-06", b, "test")).toBe(rendered);
  });

  it("detects a changed attribute", () => {
    const a = extractCatalog(FEED);
    const b = JSON.parse(JSON.stringify(a));
    b.anthropic[0].contextWindowSize = 123456;
    expect(catalogsEqual(a, b)).toBe(false);
  });
});

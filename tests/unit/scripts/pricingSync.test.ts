import { describe, test, expect } from "vitest";
import {
  perMillion,
  extractModels,
  assertSane,
  modelsEqual,
  renderDataFile,
} from "../../../scripts/pricingSync.mjs";

function orModel(id: string, prompt: string, completion: string, write: string, read: string) {
  return { id, pricing: { prompt, completion, input_cache_write: write, input_cache_read: read } };
}

describe("pricingSync", () => {
  test("perMillion converts per-token decimal strings to USD per MTok", () => {
    expect(perMillion("0.000005")).toBe(5);
    expect(perMillion("0.00000625")).toBe(6.25);
    expect(perMillion("0.0000005")).toBe(0.5);
    expect(perMillion("0.00005")).toBe(50);
  });

  test("perMillion rejects a non-numeric value", () => {
    expect(() => perMillion("n/a")).toThrow(/non-numeric/);
  });

  test("extractModels maps tracked OpenRouter slugs to plugin ids", () => {
    const payload = {
      data: [
        orModel("anthropic/claude-opus-4.8", "0.000005", "0.000025", "0.00000625", "0.0000005"),
        orModel("anthropic/claude-opus-4.7", "0.000005", "0.000025", "0.00000625", "0.0000005"),
        orModel("anthropic/claude-opus-4.6", "0.000005", "0.000025", "0.00000625", "0.0000005"),
        orModel("anthropic/claude-sonnet-4.6", "0.000003", "0.000015", "0.00000375", "0.0000003"),
        orModel("anthropic/claude-haiku-4.5", "0.000001", "0.000005", "0.00000125", "0.0000001"),
        orModel("anthropic/claude-fable-5", "0.00001", "0.00005", "0.0000125", "0.000001"),
        orModel("openai/gpt-5", "0.1", "0.2", "0", "0"), // decoy, ignored
      ],
    };
    const out = extractModels(payload);
    expect(out["claude-opus-4-8"]).toEqual({ input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 });
    expect(out["claude-haiku-4-5"]).toEqual({ input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 });
    expect(out["claude-fable-5"]).toEqual({ input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 });
    expect(Object.keys(out)).not.toContain("openai/gpt-5");
  });

  test("extractModels throws when a tracked model is absent upstream", () => {
    expect(() => extractModels({ data: [] })).toThrow(/missing upstream model/);
  });

  test("assertSane rejects a zero or negative price", () => {
    const bad = { m: { input: 0, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } };
    expect(() => assertSane(bad, {})).toThrow(/not > 0/);
  });

  test("assertSane rejects a >50% single-step move (likely upstream error)", () => {
    const prev = { "claude-opus-4-8": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } };
    const next = { "claude-opus-4-8": { input: 0.5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } };
    expect(() => assertSane(next, prev)).toThrow(/moved/);
  });

  test("assertSane allows a large move only when explicitly acknowledged", () => {
    const prev = { m: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } };
    const next = { m: { input: 0.5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } };
    expect(() => assertSane(next, prev, { allowLargeMoves: true })).not.toThrow();
  });

  test("assertSane permits small moves and brand-new models", () => {
    const prev = { m: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } };
    const small = { m: { input: 5.5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } };
    const added = { ...small, fresh: { input: 9, output: 9, cacheWrite: 9, cacheRead: 9 } };
    expect(() => assertSane(added, prev)).not.toThrow();
  });

  test("modelsEqual is true only for identical price maps", () => {
    const a = { m: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } };
    expect(modelsEqual(a, { m: { ...a.m } })).toBe(true);
    expect(modelsEqual(a, { m: { ...a.m, input: 6 } })).toBe(false);
    expect(modelsEqual(a, {})).toBe(false);
  });

  test("renderDataFile sorts model keys and ends with a newline", () => {
    const out = renderDataFile(
      "2026-06-23",
      {
        "claude-opus-4-8": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
        "claude-fable-5": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
      },
      "src"
    );
    expect(out.indexOf('"claude-fable-5"')).toBeLessThan(out.indexOf('"claude-opus-4-8"'));
    expect(out.endsWith("\n")).toBe(true);
    expect(JSON.parse(out).asOf).toBe("2026-06-23");
  });
});

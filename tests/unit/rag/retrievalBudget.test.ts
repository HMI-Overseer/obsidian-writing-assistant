import { describe, expect, it } from "vitest";
import { retrievalCharBudget } from "../../../src/rag/ragService";

/**
 * The character budget is the ceiling that decided how many results actually came back,
 * not `topK`: at the defaults (6000 chars, 1500-char chunks) it admits four. So wiring
 * `semantic_search.topK` to the retriever alone would have left the parameter almost as
 * inert as it was. The budget follows an explicit request at the same per-result
 * allowance, and is untouched without one.
 */
describe("retrievalCharBudget", () => {
  it("leaves the configured budget alone when no limit was requested", () => {
    expect(retrievalCharBudget(6000, 5, undefined)).toBe(6000);
  });

  it("keeps the configured per-result allowance when a limit was requested", () => {
    // 6000 / 5 = 1200 chars per result.
    expect(retrievalCharBudget(6000, 5, 10)).toBe(12000);
    expect(retrievalCharBudget(6000, 5, 2)).toBe(2400);
  });

  it("is identical to the configured budget when the limit matches the setting", () => {
    expect(retrievalCharBudget(6000, 5, 5)).toBe(6000);
  });

  it("survives a nonsensical configured count without dividing by zero", () => {
    expect(retrievalCharBudget(6000, 0, 4)).toBe(24000);
  });
});

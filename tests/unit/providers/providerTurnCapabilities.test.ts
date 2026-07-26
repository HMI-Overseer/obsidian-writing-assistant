import { describe, expect, it } from "vitest";
import { PROVIDER_DESCRIPTORS } from "../../../src/providers/descriptors";

describe("provider turn capabilities", () => {
  it("publishes the direct-provider maximums without exposing wire objects", () => {
    for (const provider of ["anthropic", "openai", "lmstudio"] as const) {
      expect(PROVIDER_DESCRIPTORS[provider].turnCapabilities).toEqual({
        captureOrder: "exact",
        toolCorrelation: "provider_id",
        coldReplay: "structural",
        nativeResume: false,
      });
    }
  });

  it("marks Claude Code as textual until its structural adapter lands", () => {
    expect(PROVIDER_DESCRIPTORS.claudecode.turnCapabilities).toEqual({
      captureOrder: "exact",
      toolCorrelation: "provider_id",
      coldReplay: "textual",
      nativeResume: true,
    });
  });
});

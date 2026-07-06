import { describe, it, expect } from "vitest";
import {
  normalizeCapabilities,
  normalizeNativeModel,
  normalizeReasoningCapability,
} from "../../../src/api/modelNormalization";

describe("normalizeReasoningCapability", () => {
  it("parses allowed_options and default", () => {
    expect(
      normalizeReasoningCapability({ allowed_options: ["off", "on"], default: "on" }),
    ).toEqual({ allowedOptions: ["off", "on"], default: "on" });
  });

  it("drops unknown option strings and omits an unknown default", () => {
    expect(
      normalizeReasoningCapability({ allowed_options: ["on", "turbo"], default: "turbo" }),
    ).toEqual({ allowedOptions: ["on"] });
  });

  it("returns undefined for absent, malformed, or empty payloads", () => {
    expect(normalizeReasoningCapability(undefined)).toBeUndefined();
    expect(normalizeReasoningCapability("on")).toBeUndefined();
    expect(normalizeReasoningCapability({ allowed_options: [] })).toBeUndefined();
    expect(normalizeReasoningCapability({ allowed_options: ["turbo"] })).toBeUndefined();
  });
});

describe("normalizeCapabilities", () => {
  it("keeps the reasoning capability alongside vision/tool-use", () => {
    expect(
      normalizeCapabilities({
        vision: true,
        trained_for_tool_use: true,
        reasoning: { allowed_options: ["off", "low", "medium", "high", "on"], default: "on" },
      }),
    ).toEqual({
      vision: true,
      trainedForToolUse: true,
      reasoning: { allowedOptions: ["off", "low", "medium", "high", "on"], default: "on" },
    });
  });

  // The field-observed gemma4 shape (2026-07-06): vision + tool use, NO
  // reasoning field. Absence must be preserved, it means the model cannot take
  // a reasoning setting at all, and forwarding one broke the request (jinja
  // template render failure). This is the fixture that motivated discovery
  // gating.
  it("preserves reasoning absence for models that omit the field (gemma4 shape)", () => {
    const capabilities = normalizeCapabilities({ vision: true, trained_for_tool_use: true });
    expect(capabilities).toEqual({ vision: true, trainedForToolUse: true, reasoning: undefined });
    expect(capabilities?.reasoning).toBeUndefined();
  });
});

describe("normalizeNativeModel", () => {
  it("carries the discovered reasoning capability on the model row", () => {
    const model = normalizeNativeModel({
      key: "qwen3.5",
      display_name: "Qwen 3.5",
      type: "llm",
      loaded_instances: [],
      capabilities: { reasoning: { allowed_options: ["off", "on"], default: "on" } },
    });
    expect(model?.capabilities?.reasoning).toEqual({ allowedOptions: ["off", "on"], default: "on" });
  });
});

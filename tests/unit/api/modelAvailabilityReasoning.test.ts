import { describe, it, expect } from "vitest";
import { ModelAvailabilityService } from "../../../src/api/ModelAvailabilityService";
import { DEFAULT_SETTINGS } from "../../../src/constants";

function service(): ModelAvailabilityService {
  return new ModelAvailabilityService(() => DEFAULT_SETTINGS.providerSettings);
}

describe("ModelAvailabilityService.getReasoningCapability", () => {
  it("returns undefined for a never-reported model (descriptor fallback applies)", () => {
    expect(service().getReasoningCapability("opus")).toBeUndefined();
  });

  it("serves harvested Claude Code effort levels, including a meaningful empty list", () => {
    const svc = service();
    svc.reportClaudeCodeEffortLevels({
      opus: ["low", "medium", "high", "xhigh", "max"],
      haiku: [],
    });
    expect(svc.getReasoningCapability("opus")).toEqual({
      allowedOptions: ["low", "medium", "high", "xhigh", "max"],
    });
    // Empty list = known no-effort model → capability object with no options,
    // which resolves to an empty level set (pill hidden), not the fallback.
    expect(svc.getReasoningCapability("haiku")).toEqual({ allowedOptions: [] });
  });

  it("merges successive harvests instead of replacing (absent models keep last-known levels)", () => {
    const svc = service();
    svc.reportClaudeCodeEffortLevels({ opus: ["low", "high"] });
    svc.reportClaudeCodeEffortLevels({ sonnet: ["low", "medium", "high"] });
    expect(svc.getReasoningCapability("opus")).toEqual({ allowedOptions: ["low", "high"] });
    expect(svc.getReasoningCapability("sonnet")).toEqual({
      allowedOptions: ["low", "medium", "high"],
    });
  });

  it("survives invalidate(), the harvest's source is a session, not local discovery", () => {
    const svc = service();
    svc.reportClaudeCodeEffortLevels({ opus: ["high"] });
    svc.invalidate();
    expect(svc.getReasoningCapability("opus")).toEqual({ allowedOptions: ["high"] });
  });
});

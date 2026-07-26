import { describe, expect, it } from "vitest";
import {
  resolveVaultReviewMounts,
} from "../../../../src/chat/messages/vaultReviewTimeline";

describe("vault review mounts", () => {
  it("keeps canonical controls inline and the preview on the complete tool body", () => {
    const itemEl = {} as HTMLElement;
    const labelHostEl = {} as HTMLElement;
    const presentationHostEl = {
      querySelector: (selector: string) =>
        selector.includes("lmsa-assistant-turn-tool-summary")
          ? labelHostEl
          : null,
    } as unknown as HTMLElement;
    const controlsHostEl = {
      matches: (selector: string) =>
        selector === ".lmsa-assistant-turn-action-host",
      parentElement: presentationHostEl,
      closest: (selector: string) =>
        selector === ".lmsa-assistant-turn-item" ? itemEl : null,
    } as unknown as HTMLElement;

    expect(resolveVaultReviewMounts(controlsHostEl)).toEqual({
      stateEl: itemEl,
      labelHostEl,
      controlsHostEl,
      presentationHostEl,
    });
  });

  it("keeps legacy review content inside its timeline step body", () => {
    const bodyEl = {} as HTMLElement;
    const stepEl = {
      matches: () => false,
      querySelector: (selector: string) =>
        selector.includes("lmsa-agentic-timeline-step-body")
          ? bodyEl
          : null,
    } as unknown as HTMLElement;

    expect(resolveVaultReviewMounts(stepEl)).toEqual({
      stateEl: stepEl,
      labelHostEl: bodyEl,
      controlsHostEl: bodyEl,
      presentationHostEl: bodyEl,
    });
  });
});

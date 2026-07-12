import { describe, expect, it } from "vitest";
import {
  openHeldoutPack,
  openHeldoutEvidence,
  publicHeldoutView,
  sealHeldoutCases,
  sealHeldoutEvidence,
} from "../../../experimental/optimization/heldout";
import type { HeldoutSandboxCase } from "../../../experimental/optimization/types";

const key = Buffer.alloc(32, 7).toString("base64");

function heldoutCase(): HeldoutSandboxCase {
  return {
    schemaVersion: 1,
    opaqueId: "case-alpha",
    family: "agentic",
    dimensions: ["correctness", "safety-scope"],
    qualitative: false,
    title: "Private title",
    fixture: {
      schemaVersion: 1,
      id: "private-fixture",
      version: 1,
      description: "Private fixture",
      files: [{ path: "Private/Answer.md", content: "The answer is violet seven." }],
    },
    samplingParams: {
      temperature: 0,
      maxTokens: 64,
      topP: null,
      topK: null,
      minP: null,
      repeatPenalty: null,
      reasoning: null,
    },
    request: {
      systemPrompt: "Read the private target before answering.",
      userPrompt: "What is the private answer?",
    },
    expected: {
      toolName: "read_file",
      path: "Private/Answer.md",
      finalTextIncludes: ["violet", "seven"],
      forbidControlTokens: true,
    },
  };
}

describe("sealed held-out packs", () => {
  it("exposes only opaque descriptors without prompts, fixtures, or expectations", () => {
    const pack = sealHeldoutCases("pack-1", [heldoutCase()], key, () => Buffer.alloc(12, 3));
    const serializedPublic = JSON.stringify(publicHeldoutView(pack));
    const serializedPack = JSON.stringify(pack);

    expect(serializedPublic).toContain("case-alpha");
    expect(serializedPublic).not.toContain("Private title");
    expect(serializedPublic).not.toContain("violet");
    expect(serializedPublic).not.toContain("Answer.md");
    expect(serializedPack).not.toContain("violet");
    expect(serializedPack).not.toContain("private answer");
  });

  it("opens only with the operator key and verifies public descriptors", () => {
    const pack = sealHeldoutCases("pack-1", [heldoutCase()], key, () => Buffer.alloc(12, 4));

    expect(openHeldoutPack(pack, key)).toEqual([heldoutCase()]);
    expect(() => openHeldoutPack(pack, Buffer.alloc(32, 8).toString("base64"))).toThrow(
      "authentication failed",
    );
    pack.manifest.cases[0].dimensions = ["recovery"];
    expect(() => openHeldoutPack(pack, key)).toThrow("descriptors do not match");
  });

  it("rejects duplicate identities and malformed keys", () => {
    expect(() => sealHeldoutCases("pack", [heldoutCase(), heldoutCase()], key)).toThrow(
      "duplicated",
    );
    expect(() => sealHeldoutCases("pack", [heldoutCase()], "bad-key")).toThrow("32-byte key");
  });

  it("keeps held-out trial evidence encrypted for later audit", () => {
    const sealed = sealHeldoutEvidence({ prompt: "secret", passed: true }, key);

    expect(sealed).not.toContain("secret");
    expect(openHeldoutEvidence(sealed, key)).toEqual({ prompt: "secret", passed: true });
    expect(() => openHeldoutEvidence(sealed, Buffer.alloc(32, 9).toString("base64"))).toThrow(
      "authentication failed",
    );
  });
});

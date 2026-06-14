import { describe, it, expect } from "vitest";
import {
  fingerprint,
  hashPrefix,
  isSessionUsable,
  type HarnessSession,
  type SessionConfig,
  type SessionTurn,
} from "../../../src/api/harnessSession";

function cfg(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    model: "claude-sonnet-4-6",
    systemPrompt: "Be concise.",
    reasoning: "off",
    editMode: false,
    agenticMode: true,
    toolNames: ["read_note", "search_vault"],
    ...overrides,
  };
}

function turns(...pairs: [string, string][]): SessionTurn[] {
  return pairs.map(([role, content]) => ({ role, content }));
}

/** A session that has cleanly covered `turns` and would generate the next reply. */
function metaFor(transcript: SessionTurn[], config: SessionConfig): HarnessSession {
  return {
    provider: "claudecode",
    model: config.model,
    coveredCount: transcript.length,
    prefixHash: hashPrefix(transcript, transcript.length),
    configFingerprint: fingerprint(config),
  };
}

describe("fingerprint", () => {
  it("is stable across tool-name ordering", () => {
    expect(fingerprint(cfg({ toolNames: ["a", "b"] }))).toBe(
      fingerprint(cfg({ toolNames: ["b", "a"] })),
    );
  });

  it("changes when any baked config field changes", () => {
    const base = fingerprint(cfg());
    expect(fingerprint(cfg({ model: "claude-opus-4-8" }))).not.toBe(base);
    expect(fingerprint(cfg({ systemPrompt: "different" }))).not.toBe(base);
    expect(fingerprint(cfg({ reasoning: "high" }))).not.toBe(base);
    expect(fingerprint(cfg({ editMode: true }))).not.toBe(base);
    expect(fingerprint(cfg({ agenticMode: false }))).not.toBe(base);
    expect(fingerprint(cfg({ toolNames: ["a"] }))).not.toBe(base);
  });
});

describe("hashPrefix", () => {
  it("ignores turns beyond the count", () => {
    const a = turns(["user", "hi"], ["assistant", "yo"]);
    const b = turns(["user", "hi"], ["assistant", "yo"], ["user", "more"]);
    expect(hashPrefix(a, 2)).toBe(hashPrefix(b, 2));
  });

  it("detects an edit to a covered turn", () => {
    const a = turns(["user", "hi"], ["assistant", "yo"]);
    const b = turns(["user", "HI"], ["assistant", "yo"]);
    expect(hashPrefix(a, 2)).not.toBe(hashPrefix(b, 2));
  });

  it("treats null content as empty", () => {
    expect(hashPrefix([{ role: "assistant", content: null }], 1)).toBe(
      hashPrefix([{ role: "assistant", content: "" }], 1),
    );
  });
});

describe("isSessionUsable", () => {
  it("accepts a clean one-turn extension", () => {
    const covered = turns(["user", "hi"], ["assistant", "yo"]);
    const meta = metaFor(covered, cfg());
    const live = [...covered, { role: "user", content: "next" }];
    expect(isSessionUsable(meta, live, cfg())).toBe(true);
  });

  it("rejects a model switch", () => {
    const covered = turns(["user", "hi"], ["assistant", "yo"]);
    const meta = metaFor(covered, cfg());
    const live = [...covered, { role: "user", content: "next" }];
    expect(isSessionUsable(meta, live, cfg({ model: "claude-opus-4-8" }))).toBe(false);
  });

  it("rejects config drift (e.g. edit-mode toggle)", () => {
    const covered = turns(["user", "hi"], ["assistant", "yo"]);
    const meta = metaFor(covered, cfg());
    const live = [...covered, { role: "user", content: "next" }];
    expect(isSessionUsable(meta, live, cfg({ editMode: true }))).toBe(false);
  });

  it("rejects an edit to a covered message (prefix hash)", () => {
    const covered = turns(["user", "hi"], ["assistant", "yo"]);
    const meta = metaFor(covered, cfg());
    const live = [{ role: "user", content: "HI" }, covered[1], { role: "user", content: "next" }];
    expect(isSessionUsable(meta, live, cfg())).toBe(false);
  });

  it("rejects more than one uncovered turn (foreign-provider append)", () => {
    const covered = turns(["user", "hi"], ["assistant", "yo"]);
    const meta = metaFor(covered, cfg());
    const live = [
      ...covered,
      { role: "assistant", content: "foreign reply" },
      { role: "user", content: "next" },
    ];
    expect(isSessionUsable(meta, live, cfg())).toBe(false);
  });

  it("rejects a regenerated (shorter) transcript", () => {
    const covered = turns(["user", "hi"], ["assistant", "yo"]);
    const meta = metaFor(covered, cfg());
    // Last assistant removed for regeneration → transcript ends at the user turn.
    const live = turns(["user", "hi"]);
    expect(isSessionUsable(meta, live, cfg())).toBe(false);
  });
});

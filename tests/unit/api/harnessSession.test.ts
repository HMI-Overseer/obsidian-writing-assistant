import { describe, it, expect } from "vitest";
import {
  decideReuse,
  diagnoseSessionReuse,
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
    config,
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

  it("rejects config drift (e.g. a reasoning change)", () => {
    const covered = turns(["user", "hi"], ["assistant", "yo"]);
    const meta = metaFor(covered, cfg());
    const live = [...covered, { role: "user", content: "next" }];
    expect(isSessionUsable(meta, live, cfg({ reasoning: "high" }))).toBe(false);
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

describe("diagnoseSessionReuse", () => {
  const covered = turns(["user", "hi"], ["assistant", "yo"]);
  const live: SessionTurn[] = [...covered, { role: "user", content: "next" }];

  it("reuses a clean one-turn extension", () => {
    expect(diagnoseSessionReuse(metaFor(covered, cfg()), live, cfg())).toEqual({ reuse: true });
  });

  it("attributes a rejected mismatch to the single field that drove it", () => {
    const meta = metaFor(covered, cfg());
    const cases: [Partial<SessionConfig>, string][] = [
      [{ model: "claude-opus-4-8" }, "model-changed"],
      [{ systemPrompt: "different" }, "system-prompt-changed"],
      [{ reasoning: "high" }, "reasoning-changed"],
      [{ agenticMode: false }, "agentic-mode-changed"],
      [{ toolNames: ["only_one"] }, "tools-changed"],
    ];
    for (const [override, reason] of cases) {
      expect(diagnoseSessionReuse(meta, live, cfg(override))).toEqual({ reuse: false, reason });
    }
  });

  it("does not spuriously rebuild when tool order changes", () => {
    const meta = metaFor(covered, cfg({ toolNames: ["a", "b"] }));
    expect(diagnoseSessionReuse(meta, live, cfg({ toolNames: ["b", "a"] }))).toEqual({ reuse: true });
  });

  // Phase 2 made the mode switch cache-neutral on Claude Code: mode wording left the
  // system prompt (Phase 1), the advertised tool set is the stable superset (constant
  // across modes + RAG availability), and editMode is no longer a baked field. So a
  // plan↔chat↔edit switch builds a byte-identical config and reuses the live session.
  // The end-to-end guarantee lives where the config is built (the service emits one
  // mode-invariant config); the pure invariant here is that an unchanged config reuses.
  it("reuses across a mode switch (config is mode-invariant after Phase 2)", () => {
    const meta = metaFor(covered, cfg());
    expect(diagnoseSessionReuse(meta, live, cfg())).toEqual({ reuse: true });
  });

  // Single-field attribution still names the highest-priority changed field when
  // several baked fields move at once (the masking the design doc notes); priority
  // order is systemPrompt → reasoning → agentic → tools.
  it("names the highest-priority field when several change at once", () => {
    const meta = metaFor(covered, cfg());
    const drift = cfg({ systemPrompt: "different", toolNames: ["only_one"] });
    expect(diagnoseSessionReuse(meta, live, drift)).toEqual({
      reuse: false,
      reason: "system-prompt-changed",
    });
  });

  it("reports turn-count when more than the new user turn is uncovered", () => {
    const meta = metaFor(covered, cfg());
    const foreign = [...covered, { role: "assistant", content: "foreign" }, { role: "user", content: "next" }];
    expect(diagnoseSessionReuse(meta, foreign, cfg())).toEqual({ reuse: false, reason: "turn-count" });
  });

  it("reports history-edited when a covered turn was mutated", () => {
    const meta = metaFor(covered, cfg());
    const edited = [{ role: "user", content: "HI" }, covered[1], { role: "user", content: "next" }];
    expect(diagnoseSessionReuse(meta, edited, cfg())).toEqual({ reuse: false, reason: "history-edited" });
  });

  it("reports provider-mismatch for a non-claudecode session", () => {
    const meta = { ...metaFor(covered, cfg()), provider: "other" as HarnessSession["provider"] };
    expect(diagnoseSessionReuse(meta, live, cfg())).toEqual({ reuse: false, reason: "provider-mismatch" });
  });

  it("falls back to config-changed when the prior config was not retained", () => {
    const meta: HarnessSession = { ...metaFor(covered, cfg()), config: undefined };
    // Fingerprint still mismatches (systemPrompt drift), but with no prior config
    // to diff, the specific field can't be named.
    expect(diagnoseSessionReuse(meta, live, cfg({ systemPrompt: "different" }))).toEqual({
      reuse: false,
      reason: "config-changed",
    });
  });
});

describe("decideReuse", () => {
  const covered = turns(["user", "hi"], ["assistant", "yo"]);
  const live: SessionTurn[] = [...covered, { role: "user", content: "next" }];

  it("reports no-session when nothing is held", () => {
    expect(decideReuse(undefined, live, cfg())).toEqual({ reuse: false, reason: "no-session" });
  });

  it("reports session-disposed when the held session is dead", () => {
    const existing = { isDisposed: true, meta: metaFor(covered, cfg()) };
    expect(decideReuse(existing, live, cfg())).toEqual({ reuse: false, reason: "session-disposed" });
  });

  it("delegates to the per-session diagnosis for a live session", () => {
    const existing = { isDisposed: false, meta: metaFor(covered, cfg()) };
    expect(decideReuse(existing, live, cfg())).toEqual({ reuse: true });
    expect(decideReuse(existing, live, cfg({ systemPrompt: "different" }))).toEqual({
      reuse: false,
      reason: "system-prompt-changed",
    });
  });
});

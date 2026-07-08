import { describe, it, expect } from "vitest";
import {
  normalizeClaudeCodeEffortLevels,
  normalizeGate,
  normalizePluginSettings,
  normalizeProviderProfiles,
  normalizeReasoningByModelKey,
  normalizeVaultOpPolicy,
  normalizeActiveProfileIds,
  normalizeRagSettings,
} from "../../../src/settings/settingsMigration";
import { DEFAULT_SETTINGS, DEFAULT_ACTIVE_PROFILE_IDS, DEFAULT_RAG_SETTINGS } from "../../../src/constants";
import { DEFAULT_VAULT_OP_POLICY } from "../../../src/vault-ops/gateway";
import { PROVIDER_DESCRIPTORS } from "../../../src/providers/descriptors";

describe("normalizePluginSettings", () => {
  it("returns a full defaults object for null (first run)", () => {
    expect(normalizePluginSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it("returns a full defaults object for an empty blob", () => {
    expect(normalizePluginSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it("applies valid scalar overrides and defaults the rest", () => {
    const result = normalizePluginSettings({
      maxContextChars: 9000,
      agenticMode: true,
      systemPromptPrefix: "custom prefix",
    });
    expect(result.maxContextChars).toBe(9000);
    expect(result.agenticMode).toBe(true);
    expect(result.systemPromptPrefix).toBe("custom prefix");
    // untouched fields fall back to defaults
    expect(result.maxToolRounds).toBe(DEFAULT_SETTINGS.maxToolRounds);
  });

  // The per-mode round budgets (maxToolRoundsEdit / maxToolRoundsChat) collapsed into
  // one maxToolRounds (prompt-cache cleanup 2). A customized legacy value is carried
  // forward, the live chat budget preferred over the dead edit budget; a present new
  // field wins; old data carrying both legacy fields must not crash.
  it("migrates the legacy per-mode tool-round budgets into maxToolRounds", () => {
    const bothLegacy = normalizePluginSettings({
      maxToolRoundsChat: 12,
      maxToolRoundsEdit: 7,
    } as unknown as Partial<PluginSettings>);
    expect(bothLegacy.maxToolRounds).toBe(12);

    const editOnly = normalizePluginSettings({
      maxToolRoundsEdit: 9,
    } as unknown as Partial<PluginSettings>);
    expect(editOnly.maxToolRounds).toBe(9);

    const newWins = normalizePluginSettings({
      maxToolRounds: 30,
      maxToolRoundsChat: 12,
    } as unknown as Partial<PluginSettings>);
    expect(newWins.maxToolRounds).toBe(30);
  });

  // The plan/chat/edit mode prompts collapsed into one unified systemPromptPrefix
  // (prompt-cache design section 6.3). A user's customized legacy chat (then plan) prefix is
  // carried forward; a new systemPromptPrefix wins over any legacy field.
  it("migrates a legacy chat/plan prompt prefix into systemPromptPrefix", () => {
    const fromChat = normalizePluginSettings({
      chatSystemPromptPrefix: "my chat prefix",
    } as unknown as Partial<PluginSettings>);
    expect(fromChat.systemPromptPrefix).toBe("my chat prefix");

    const fromPlan = normalizePluginSettings({
      planSystemPromptPrefix: "my plan prefix",
    } as unknown as Partial<PluginSettings>);
    expect(fromPlan.systemPromptPrefix).toBe("my plan prefix");

    const newWins = normalizePluginSettings({
      systemPromptPrefix: "new",
      chatSystemPromptPrefix: "old chat",
    } as unknown as Partial<PluginSettings>);
    expect(newWins.systemPromptPrefix).toBe("new");
  });

  it("rejects wrong-typed scalars and falls back to defaults", () => {
    const result = normalizePluginSettings({
      maxContextChars: "lots" as unknown as number,
      agenticMode: "yes" as unknown as boolean,
    });
    expect(result.maxContextChars).toBe(DEFAULT_SETTINGS.maxContextChars);
    expect(result.agenticMode).toBe(DEFAULT_SETTINGS.agenticMode);
  });

  it("normalizes each command by index, defaulting missing fields", () => {
    const result = normalizePluginSettings({
      commands: [{ prompt: "do it" }, { name: "Named", id: "x", icon: "  " }] as never,
    });
    expect(result.commands).toEqual([
      { id: "command-1", name: "Command 1", prompt: "do it", icon: "wand" },
      { id: "x", name: "Named", prompt: "", icon: "wand" },
    ]);
  });

  it("drops a non-array commands blob to an empty list", () => {
    const result = normalizePluginSettings({ commands: "nope" as unknown as never });
    expect(result.commands).toEqual([]);
  });

  it("normalizes favoriteModelKeys: keeps composed keys, drops junk, dedupes", () => {
    const result = normalizePluginSettings({
      favoriteModelKeys: [
        "anthropic:claude-fable-5",
        "anthropic:claude-fable-5", // duplicate
        "lmstudio:qwen3-8b",
        "model-1", // legacy synthetic id, not a composed key
        "notaprovider:thing", // prefix is not a valid provider
        42,
        "",
      ] as unknown as string[],
    });
    expect(result.favoriteModelKeys).toEqual(["anthropic:claude-fable-5", "lmstudio:qwen3-8b"]);
  });

  it("defaults favoriteModelKeys to [] when missing or non-array", () => {
    expect(normalizePluginSettings({}).favoriteModelKeys).toEqual([]);
    const wrongType = normalizePluginSettings({
      favoriteModelKeys: "anthropic:claude-fable-5" as unknown as string[],
    });
    expect(wrongType.favoriteModelKeys).toEqual([]);
  });
});

describe("normalizeGate", () => {
  it("passes through a valid three-way gate string", () => {
    expect(normalizeGate("auto", "ask")).toBe("auto");
    expect(normalizeGate("ask", "deny")).toBe("ask");
    expect(normalizeGate("deny", "auto")).toBe("deny");
  });

  it("migrates the legacy binary boolean (false -> deny, true -> ask)", () => {
    expect(normalizeGate(false, "auto")).toBe("deny");
    expect(normalizeGate(true, "deny")).toBe("ask");
  });

  it("falls back for an unknown string or junk", () => {
    expect(normalizeGate("maybe", "ask")).toBe("ask");
    expect(normalizeGate(42, "deny")).toBe("deny");
    expect(normalizeGate(undefined, "auto")).toBe("auto");
  });
});

describe("normalizeVaultOpPolicy", () => {
  it("defaults a missing policy entirely", () => {
    expect(normalizeVaultOpPolicy(undefined)).toEqual(DEFAULT_VAULT_OP_POLICY);
  });

  it("migrates per-class booleans and clamps maxAutoOps", () => {
    const policy = normalizeVaultOpPolicy({
      create: true,
      trash: false,
      maxAutoOps: 7.9,
      scopes: ["Notes", 3],
    });
    expect(policy.create).toBe("ask");
    expect(policy.trash).toBe("deny");
    expect(policy.maxAutoOps).toBe(7);
    expect(policy.scopes).toEqual(["Notes"]);
    // unspecified classes keep their defaults
    expect(policy.move).toBe(DEFAULT_VAULT_OP_POLICY.move);
  });

  it("rejects a negative maxAutoOps", () => {
    expect(normalizeVaultOpPolicy({ maxAutoOps: -1 }).maxAutoOps).toBe(
      DEFAULT_VAULT_OP_POLICY.maxAutoOps,
    );
  });
});

describe("normalizeProviderProfiles", () => {
  it("keeps well-formed non-default profiles and drops the rest", () => {
    const profiles = normalizeProviderProfiles([
      { id: "a", name: "A", provider: "anthropic", isDefault: false },
      { id: "b", name: "B", provider: "anthropic", isDefault: true }, // default dropped
      { id: "c", name: "C", provider: "made-up" }, // unknown provider dropped
      { name: "D", provider: "openai" }, // missing id dropped
    ]);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].id).toBe("a");
  });

  it("returns an empty list for a non-array", () => {
    expect(normalizeProviderProfiles(null)).toEqual([]);
  });

  it("accepts a profile for every registered provider (VALID_PROVIDERS derives from descriptors)", () => {
    const keys = Object.keys(PROVIDER_DESCRIPTORS);
    const profiles = keys.map((provider, i) => ({
      id: `p${i}`,
      name: provider,
      provider,
      isDefault: false,
    }));
    // If VALID_PROVIDERS were a stale hardcoded list missing a descriptor key,
    // that provider's profile would be dropped and the lengths would diverge.
    expect(normalizeProviderProfiles(profiles)).toHaveLength(keys.length);
  });

  it("drops the retired per-profile reasoning field (one-way migration to the per-model map)", () => {
    const profiles = normalizeProviderProfiles([
      { id: "a", name: "A", provider: "anthropic", isDefault: false, reasoning: "high" },
    ]);
    expect(profiles[0]).not.toHaveProperty("reasoning");
  });
});

describe("normalizeReasoningByModelKey", () => {
  it("keeps composed-key entries with known levels", () => {
    expect(
      normalizeReasoningByModelKey({
        "claudecode:opus": "xhigh",
        "lmstudio:qwen3.5": "on",
      }),
    ).toEqual({ "claudecode:opus": "xhigh", "lmstudio:qwen3.5": "on" });
  });

  it("drops malformed keys, unknown levels, and non-string values", () => {
    expect(
      normalizeReasoningByModelKey({
        "not-a-composed-key": "high", // no provider prefix
        "madeup:model": "high", // unknown provider
        "claudecode:opus": "ultra", // not a level
        "openai:gpt": 3, // not a string
      }),
    ).toEqual({});
  });

  it("returns an empty map for non-object input", () => {
    expect(normalizeReasoningByModelKey(null)).toEqual({});
    expect(normalizeReasoningByModelKey("high")).toEqual({});
  });
});

describe("normalizeClaudeCodeEffortLevels", () => {
  it("keeps alias-keyed level lists, including meaningful empty lists", () => {
    expect(
      normalizeClaudeCodeEffortLevels({
        opus: ["low", "medium", "high", "xhigh", "max"],
        haiku: [],
      }),
    ).toEqual({ opus: ["low", "medium", "high", "xhigh", "max"], haiku: [] });
  });

  it("drops junk values but filters mixed lists", () => {
    expect(
      normalizeClaudeCodeEffortLevels({
        opus: "high", // not an array
        sonnet: ["ultracode"], // junk-only → dropped, degrade to fallback
        fable: ["high", "ultracode"], // mixed → filtered
        "": ["high"], // empty key
      }),
    ).toEqual({ fable: ["high"] });
  });

  it("returns an empty map for non-object input", () => {
    expect(normalizeClaudeCodeEffortLevels(null)).toEqual({});
    expect(normalizeClaudeCodeEffortLevels([])).toEqual({});
  });
});

describe("normalizeActiveProfileIds", () => {
  it("overrides only string-valued provider keys", () => {
    const ids = normalizeActiveProfileIds({ anthropic: "my-claude", openai: 7 });
    expect(ids.anthropic).toBe("my-claude");
    expect(ids.openai).toBe(DEFAULT_ACTIVE_PROFILE_IDS.openai);
  });

  it("returns defaults for a non-object", () => {
    expect(normalizeActiveProfileIds("x")).toEqual(DEFAULT_ACTIVE_PROFILE_IDS);
  });
});

describe("normalizeRagSettings", () => {
  it("filters non-string exclude patterns and defaults bad numerics", () => {
    const rag = normalizeRagSettings({
      excludePatterns: ["a/**", 5, "b/**"],
      chunkSize: "big",
      topK: 9,
    });
    expect(rag.excludePatterns).toEqual(["a/**", "b/**"]);
    expect(rag.chunkSize).toBe(DEFAULT_RAG_SETTINGS.chunkSize);
    expect(rag.topK).toBe(9);
  });

  it("back-fills auto-reindex flags for settings saved before they existed", () => {
    // A pre-feature blob has none of the auto-reindex keys.
    const rag = normalizeRagSettings({ enabled: true, chunkSize: 1200 });
    expect(rag.reindexOnStartup).toBe(DEFAULT_RAG_SETTINGS.reindexOnStartup);
    expect(rag.watchForChanges).toBe(DEFAULT_RAG_SETTINGS.watchForChanges);
    expect(rag.autoReindexOnCloud).toBe(DEFAULT_RAG_SETTINGS.autoReindexOnCloud);
  });

  it("preserves explicit auto-reindex flags", () => {
    const rag = normalizeRagSettings({
      reindexOnStartup: false,
      watchForChanges: false,
      autoReindexOnCloud: true,
    });
    expect(rag.reindexOnStartup).toBe(false);
    expect(rag.watchForChanges).toBe(false);
    expect(rag.autoReindexOnCloud).toBe(true);
  });
});

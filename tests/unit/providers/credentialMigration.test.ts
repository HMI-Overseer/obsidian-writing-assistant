import { describe, it, expect } from "vitest";
import {
  migrateProviderCredentials,
  SECRET_IDS,
  type KeyedProvider,
  type SecretWriter,
} from "../../../src/providers/credentials";

/**
 * The credential move (ADR-0039 part 3).
 *
 * These failure paths are close to unreachable in normal operation: we are
 * desktop-only, so the storage adapter always exists, and we author the ids, so
 * validation never rejects one. That is exactly why they are tested rather than
 * commented. An untested failure path here is a path that rots silently and
 * destroys a credential the first time it runs.
 */

/** A fake secret store. `onSet` lets a test make the write throw or lie. */
function fakeSecrets(
  initial: Record<string, string> = {},
  onSet?: (id: string, value: string) => void,
): SecretWriter & { store: Record<string, string>; setCalls: string[] } {
  const store = { ...initial };
  const setCalls: string[] = [];
  return {
    store,
    setCalls,
    getSecret: (id) => (Object.hasOwn(store, id) ? store[id] : null),
    setSecret: (id, secret) => {
      setCalls.push(id);
      if (onSet) {
        onSet(id, secret);
        return;
      }
      store[id] = secret;
    },
    listSecrets: () => Object.keys(store),
  };
}

function blobWith(anthropic: Record<string, unknown>): Record<string, unknown> {
  return { providerSettings: { anthropic, openai: {}, lmstudio: {}, claudecode: {} } };
}

function anthropicRecord(raw: Record<string, unknown> | null): Record<string, unknown> {
  return (raw?.providerSettings as Record<string, unknown>).anthropic as Record<string, unknown>;
}

function outcomeFor(
  outcomes: ReturnType<typeof migrateProviderCredentials>["outcomes"],
  provider: KeyedProvider,
) {
  return outcomes.find((o) => o.provider === provider);
}

describe("migrateProviderCredentials", () => {
  it("relocates a plaintext key, records the id, and removes the plaintext field", () => {
    const secrets = fakeSecrets();
    const { raw, outcomes, changed } = migrateProviderCredentials(
      blobWith({ enabled: true, apiKey: "sk-ant-real" }),
      secrets,
    );

    expect(secrets.store[SECRET_IDS.anthropic]).toBe("sk-ant-real");
    const record = anthropicRecord(raw);
    expect(record.apiKeySecretId).toBe(SECRET_IDS.anthropic);
    // Assert by key presence, not by value: a scrub that writes "" would leave the
    // credential's slot in the file and read as success in a value comparison. The
    // absence is the entire point of the exercise.
    expect(Object.hasOwn(record, "apiKey")).toBe(false);
    expect(outcomeFor(outcomes, "anthropic")?.result).toBe("migrated");
    expect(changed).toBe(true);
  });

  it("leaves the other provider untouched", () => {
    const secrets = fakeSecrets();
    const { outcomes } = migrateProviderCredentials(
      blobWith({ apiKey: "sk-ant-real" }),
      secrets,
    );
    expect(outcomeFor(outcomes, "openai")?.result).toBe("none");
    expect(secrets.store[SECRET_IDS.openai]).toBeUndefined();
  });

  it("is idempotent: a second pass over a migrated blob writes nothing", () => {
    const secrets = fakeSecrets();
    const first = migrateProviderCredentials(blobWith({ apiKey: "sk-ant-real" }), secrets);
    const second = migrateProviderCredentials(first.raw, secrets);

    expect(second.changed).toBe(false);
    expect(outcomeFor(second.outcomes, "anthropic")?.result).toBe("none");
    expect(secrets.setCalls).toEqual([SECRET_IDS.anthropic]);
  });

  it("adopts our own id when a previous run already wrote the same value", () => {
    // A run that relocated the key but crashed before the blob was saved.
    const secrets = fakeSecrets({ [SECRET_IDS.anthropic]: "sk-ant-real" });
    const { raw, outcomes } = migrateProviderCredentials(
      blobWith({ apiKey: "sk-ant-real" }),
      secrets,
    );

    expect(secrets.setCalls).toEqual([]);
    const record = anthropicRecord(raw);
    expect(record.apiKeySecretId).toBe(SECRET_IDS.anthropic);
    expect(Object.hasOwn(record, "apiKey")).toBe(false);
    expect(outcomeFor(outcomes, "anthropic")?.result).toBe("adopted");
  });

  it("refuses a collision: our id held by a value we did not write", () => {
    const secrets = fakeSecrets({ [SECRET_IDS.anthropic]: "someone-elses-secret" });
    const { raw, outcomes, changed, retained } = migrateProviderCredentials(
      blobWith({ apiKey: "sk-ant-real" }),
      secrets,
    );

    // Neither adopt nor suffix. Adopting would silently send an unknown credential
    // to the provider; suffixing would leave two near-identical keychain entries
    // forever. Refusing costs no extra code because the failure path already exists.
    expect(secrets.setCalls).toEqual([]);
    expect(secrets.store[SECRET_IDS.anthropic]).toBe("someone-elses-secret");
    const record = anthropicRecord(raw);
    expect(record.apiKey).toBe("sk-ant-real");
    expect(record.apiKeySecretId).toBeUndefined();
    expect(outcomeFor(outcomes, "anthropic")?.result).toBe("collision");
    expect(changed).toBe(false);
    expect(retained.get("anthropic")).toBe("sk-ant-real");
  });

  it("retries a collision on the next launch rather than sticking", () => {
    // The aim is for this to work, not merely to fail gracefully. A stuck state
    // must be a test failure rather than a discovery.
    const secrets = fakeSecrets({ [SECRET_IDS.anthropic]: "someone-elses-secret" });
    const first = migrateProviderCredentials(blobWith({ apiKey: "sk-ant-real" }), secrets);
    expect(outcomeFor(first.outcomes, "anthropic")?.result).toBe("collision");

    // The user resolves it by linking the existing secret through the card.
    anthropicRecord(first.raw).apiKeySecretId = SECRET_IDS.anthropic;

    const second = migrateProviderCredentials(first.raw, secrets);
    expect(outcomeFor(second.outcomes, "anthropic")?.result).toBe("adopted");
    expect(Object.hasOwn(anthropicRecord(second.raw), "apiKey")).toBe(false);

    // And the launch after that has nothing left to do.
    const third = migrateProviderCredentials(second.raw, secrets);
    expect(outcomeFor(third.outcomes, "anthropic")?.result).toBe("none");
  });

  it("fails closed when setSecret throws: the plaintext stays and no id is written", () => {
    const secrets = fakeSecrets({}, () => {
      throw new Error("Secure storage is not available.");
    });
    const { raw, outcomes, changed, retained } = migrateProviderCredentials(
      blobWith({ apiKey: "sk-ant-real" }),
      secrets,
    );

    const record = anthropicRecord(raw);
    expect(record.apiKey).toBe("sk-ant-real");
    expect(record.apiKeySecretId).toBeUndefined();
    expect(outcomeFor(outcomes, "anthropic")).toMatchObject({
      result: "failed",
      error: "Secure storage is not available.",
    });
    expect(changed).toBe(false);
    expect(retained.get("anthropic")).toBe("sk-ant-real");
  });

  it("fails closed when the write succeeds but the value does not read back", () => {
    // A write that reports success and stores something else is indistinguishable
    // from success at the call site, so the verify step is what catches it.
    const secrets = fakeSecrets({}, function (this: void, id: string) {
      secrets.store[id] = "corrupted";
    });
    const { raw, outcomes, changed } = migrateProviderCredentials(
      blobWith({ apiKey: "sk-ant-real" }),
      secrets,
    );

    expect(anthropicRecord(raw).apiKey).toBe("sk-ant-real");
    expect(anthropicRecord(raw).apiKeySecretId).toBeUndefined();
    expect(outcomeFor(outcomes, "anthropic")?.result).toBe("failed");
    expect(changed).toBe(false);
  });

  it("retries a failure on the next launch and heals with no user action", () => {
    let available = false;
    const secrets = fakeSecrets({}, (id, value) => {
      if (!available) throw new Error("Secure storage is not available.");
      secrets.store[id] = value;
    });

    const first = migrateProviderCredentials(blobWith({ apiKey: "sk-ant-real" }), secrets);
    expect(outcomeFor(first.outcomes, "anthropic")?.result).toBe("failed");

    available = true;
    const second = migrateProviderCredentials(first.raw, secrets);
    expect(outcomeFor(second.outcomes, "anthropic")?.result).toBe("migrated");
    expect(Object.hasOwn(anthropicRecord(second.raw), "apiKey")).toBe(false);
  });

  it("scrubs redundant plaintext once the user has linked a secret by hand", () => {
    // The other half of "one click resolves it permanently": with no clause for an
    // already-linked id, the plaintext would survive every relaunch behind an id
    // that resolves perfectly well.
    const secrets = fakeSecrets({ "my-own-anthropic-key": "sk-ant-real" });
    const { raw, outcomes } = migrateProviderCredentials(
      blobWith({ apiKey: "sk-ant-real", apiKeySecretId: "my-own-anthropic-key" }),
      secrets,
    );

    expect(secrets.setCalls).toEqual([]);
    expect(anthropicRecord(raw).apiKeySecretId).toBe("my-own-anthropic-key");
    expect(Object.hasOwn(anthropicRecord(raw), "apiKey")).toBe(false);
    expect(outcomeFor(outcomes, "anthropic")?.result).toBe("adopted");
  });

  it("does not treat a dangling linked id as a reason to scrub", () => {
    // The id is linked but its secret is gone, so the plaintext is the only working
    // credential left and must survive.
    const secrets = fakeSecrets();
    const { raw, outcomes } = migrateProviderCredentials(
      blobWith({ apiKey: "sk-ant-real", apiKeySecretId: "deleted-secret" }),
      secrets,
    );

    expect(anthropicRecord(raw).apiKeySecretId).toBe(SECRET_IDS.anthropic);
    expect(Object.hasOwn(anthropicRecord(raw), "apiKey")).toBe(false);
    expect(outcomeFor(outcomes, "anthropic")?.result).toBe("migrated");
    expect(secrets.store[SECRET_IDS.anthropic]).toBe("sk-ant-real");
  });

  it("handles a first-run blob and a blob with no providerSettings", () => {
    const secrets = fakeSecrets();
    for (const raw of [null, {}, { providerSettings: null }]) {
      const result = migrateProviderCredentials(raw as Record<string, unknown> | null, secrets);
      expect(result.changed).toBe(false);
      expect(result.outcomes.every((o) => o.result === "none")).toBe(true);
    }
    expect(secrets.setCalls).toEqual([]);
  });

  it("ignores an empty-string plaintext key rather than storing one", () => {
    const secrets = fakeSecrets();
    const { outcomes, changed } = migrateProviderCredentials(blobWith({ apiKey: "" }), secrets);
    expect(outcomeFor(outcomes, "anthropic")?.result).toBe("none");
    expect(changed).toBe(false);
    expect(secrets.setCalls).toEqual([]);
  });
});

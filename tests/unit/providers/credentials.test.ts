import { describe, it, expect } from "vitest";
import {
  SecretStorageCredentialStore,
  hasLinkedCredential,
  SECRET_IDS,
  type KeyedProvider,
  type SecretWriter,
} from "../../../src/providers/credentials";
import type { PluginSettings, ProviderSettingsMap } from "../../../src/shared/types";

/** A fake secret store, standing in for `app.secretStorage`. */
function fakeSecrets(initial: Record<string, string> = {}): SecretWriter & {
  store: Record<string, string>;
} {
  const store = { ...initial };
  return {
    store,
    getSecret: (id) => (Object.hasOwn(store, id) ? store[id] : null),
    setSecret: (id, secret) => {
      store[id] = secret;
    },
    listSecrets: () => Object.keys(store),
  };
}

function settingsWith(ids: { anthropic?: string; openai?: string } = {}): ProviderSettingsMap {
  return {
    lmstudio: { enabled: true, baseUrl: "http://localhost:1234/v1", bypassCors: true },
    anthropic: { enabled: true, apiKeySecretId: ids.anthropic ?? "" },
    openai: {
      enabled: true,
      apiKeySecretId: ids.openai ?? "",
      baseUrl: "https://api.openai.com/v1",
    },
    claudecode: { enabled: false, claudePath: "" },
  };
}

/**
 * Secret ids are a name in a namespace shared with every other plugin in the vault,
 * and Obsidian validates them. Both facts are checked here rather than trusted,
 * because `setSecret` throwing on an invalid id is a migration failure path that
 * normal use never exercises.
 */
describe("secret ids", () => {
  it("satisfies Obsidian's id rules", () => {
    for (const id of Object.values(SECRET_IDS)) {
      expect(id).toMatch(/^[a-z0-9-]+$/);
      expect(id.length).toBeLessThanOrEqual(64);
    }
  });

  it("derives from the permanent plugin id and is distinct per provider", () => {
    expect(SECRET_IDS.anthropic).toBe("writing-assistant-chat-anthropic");
    expect(SECRET_IDS.openai).toBe("writing-assistant-chat-openai");
  });
});

describe("SecretStorageCredentialStore", () => {
  it("resolves a linked secret and reports ok", () => {
    const secrets = fakeSecrets({ [SECRET_IDS.anthropic]: "sk-ant-real" });
    const store = new SecretStorageCredentialStore(secrets, () =>
      settingsWith({ anthropic: SECRET_IDS.anthropic }),
    );
    expect(store.resolve("anthropic")).toBe("sk-ant-real");
    expect(store.state("anthropic")).toBe("ok");
  });

  it("reports an empty id as unlinked and resolves to null, never to an empty string", () => {
    // An empty string reaching a header builder would send `Bearer ` and earn a 401
    // instead of the missing-credential message, so the collapse to null is the
    // contract, not an implementation detail.
    const store = new SecretStorageCredentialStore(fakeSecrets(), () => settingsWith());
    expect(store.resolve("anthropic")).toBeNull();
    expect(store.state("anthropic")).toBe("unlinked");
  });

  it("distinguishes a dangling id from never having configured one", () => {
    // The state `SecretComponent` cannot express: `setValue` on a deleted secret
    // renders identically to "never configured", so the card has to say it.
    const store = new SecretStorageCredentialStore(fakeSecrets(), () =>
      settingsWith({ anthropic: SECRET_IDS.anthropic }),
    );
    expect(store.resolve("anthropic")).toBeNull();
    expect(store.state("anthropic")).toBe("missing");
  });

  it("re-reads secret storage on every call, so a deletion takes effect immediately", () => {
    const secrets = fakeSecrets({ [SECRET_IDS.openai]: "sk-real" });
    const store = new SecretStorageCredentialStore(secrets, () =>
      settingsWith({ openai: SECRET_IDS.openai }),
    );
    expect(store.resolve("openai")).toBe("sk-real");
    delete secrets.store[SECRET_IDS.openai];
    expect(store.resolve("openai")).toBeNull();
    expect(store.state("openai")).toBe("missing");
  });

  it("keeps the two keyed providers independent", () => {
    const secrets = fakeSecrets({ [SECRET_IDS.anthropic]: "sk-ant-real" });
    const store = new SecretStorageCredentialStore(secrets, () =>
      settingsWith({ anthropic: SECRET_IDS.anthropic }),
    );
    expect(store.state("anthropic")).toBe("ok");
    expect(store.state("openai")).toBe("unlinked");
  });

  it("resolves an id the user chose themselves, not only the one we author", () => {
    const secrets = fakeSecrets({ "my-own-key": "sk-ant-real" });
    const store = new SecretStorageCredentialStore(secrets, () =>
      settingsWith({ anthropic: "my-own-key" }),
    );
    expect(store.resolve("anthropic")).toBe("sk-ant-real");
  });
});

/**
 * Fail-closed is stated as a property of the migration, but the migration is not
 * what deletes the plaintext: normalization is. These cover the save boundary, where
 * the first settings change anywhere in the app would otherwise scrub the very key a
 * failed migration preserved.
 */
describe("the session overlay after a failed migration", () => {
  const retained = new Map<KeyedProvider, string>([["anthropic", "sk-ant-real"]]);

  function overlayStore() {
    return new SecretStorageCredentialStore(fakeSecrets(), () => settingsWith(), retained);
  }

  it("keeps the provider working for the session", () => {
    const store = overlayStore();
    expect(store.resolve("anthropic")).toBe("sk-ant-real");
    expect(store.state("anthropic")).toBe("ok");
    expect(store.resolve("openai")).toBeNull();
  });

  it("prefers a linked secret over the overlay once one resolves", () => {
    const secrets = fakeSecrets({ [SECRET_IDS.anthropic]: "sk-ant-new" });
    const store = new SecretStorageCredentialStore(
      secrets,
      () => settingsWith({ anthropic: SECRET_IDS.anthropic }),
      retained,
    );
    expect(store.resolve("anthropic")).toBe("sk-ant-new");
  });

  it("re-attaches the plaintext onto the object saveData receives", () => {
    const settings = { providerSettings: settingsWith() } as PluginSettings;
    const blob = overlayStore().withLegacyOverlay(settings);

    const providers = blob.providerSettings as Record<string, Record<string, unknown>>;
    expect(providers.anthropic.apiKey).toBe("sk-ant-real");
    expect(providers.anthropic.apiKeySecretId).toBe("");
    // Only the failed provider. The other must not gain a field it never had.
    expect(Object.hasOwn(providers.openai, "apiKey")).toBe(false);
  });

  it("does not mutate the live settings object it was handed", () => {
    const settings = { providerSettings: settingsWith() } as PluginSettings;
    overlayStore().withLegacyOverlay(settings);
    expect(Object.hasOwn(settings.providerSettings.anthropic, "apiKey")).toBe(false);
  });

  it("retires the plaintext once the user links a secret that resolves on its own", () => {
    // The other half of "one click resolves it permanently". Without this the overlay
    // would re-attach the key on every save until the next launch, so the user's fix
    // would appear not to have worked.
    const secrets = fakeSecrets({ "my-own-key": "sk-ant-new" });
    const store = new SecretStorageCredentialStore(
      secrets,
      () => settingsWith({ anthropic: "my-own-key" }),
      retained,
    );

    expect(store.retireLegacyKeyIfLinked("anthropic")).toBe(true);
    const settings = {
      providerSettings: settingsWith({ anthropic: "my-own-key" }),
    } as PluginSettings;
    const providers = store.withLegacyOverlay(settings).providerSettings as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.hasOwn(providers.anthropic, "apiKey")).toBe(false);
    expect(store.resolve("anthropic")).toBe("sk-ant-new");
  });

  it("keeps the plaintext when the freshly linked id does not resolve", () => {
    // Linking a dangling id must not retire the only working credential left.
    const store = new SecretStorageCredentialStore(
      fakeSecrets(),
      () => settingsWith({ anthropic: "deleted-secret" }),
      retained,
    );
    expect(store.retireLegacyKeyIfLinked("anthropic")).toBe(false);
    expect(store.resolve("anthropic")).toBe("sk-ant-real");
  });

  it("reports nothing retired when there was no overlay to begin with", () => {
    const secrets = fakeSecrets({ [SECRET_IDS.openai]: "sk-real" });
    const store = new SecretStorageCredentialStore(secrets, () =>
      settingsWith({ openai: SECRET_IDS.openai }),
    );
    expect(store.retireLegacyKeyIfLinked("openai")).toBe(false);
  });

  it("carries nothing after a successful migration", () => {
    const store = new SecretStorageCredentialStore(fakeSecrets(), () => settingsWith());
    const settings = { providerSettings: settingsWith() } as PluginSettings;
    const providers = store.withLegacyOverlay(settings).providerSettings as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.hasOwn(providers.anthropic, "apiKey")).toBe(false);
    expect(Object.hasOwn(providers.openai, "apiKey")).toBe(false);
  });
});

describe("hasLinkedCredential (what enablement gates on)", () => {
  it("counts a linked id", () => {
    expect(hasLinkedCredential({ apiKeySecretId: SECRET_IDS.anthropic })).toBe(true);
  });

  it("counts plaintext that survived a failed migration", () => {
    // Without this clause a provider whose key still works through the overlay would
    // be force-disabled at load, the opposite of what fail-closed preserved it for.
    expect(hasLinkedCredential({ apiKey: "sk-ant-real" })).toBe(true);
  });

  it("counts neither an empty id nor an empty key nor a missing record", () => {
    expect(hasLinkedCredential({ apiKeySecretId: "", apiKey: "" })).toBe(false);
    expect(hasLinkedCredential({})).toBe(false);
    expect(hasLinkedCredential(undefined)).toBe(false);
  });
});

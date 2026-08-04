/**
 * Where a provider credential comes from, and nothing else.
 *
 * ADR-0039 moves provider API keys out of plugin data and into Obsidian's secret
 * storage. This module is the single seam that decision needs: every consumer asks a
 * {@link CredentialStore} for a credential at the moment it makes a request, and no
 * consumer knows whether that credential came from a settings field or from the
 * keychain. Swapping the implementation is the whole of the move.
 *
 * Two rules hold the design together:
 *
 * - **A client holds a thunk, never a credential string.** `RagService` and
 *   `GraphService` build a client once in `configure()` and keep it for the life of
 *   the service, so a client that captured a key would keep it alive long after the
 *   user deleted the secret. A client that captures a {@link CredentialResolver} may
 *   live as long as it likes, because it holds nothing.
 * - **Nothing outside this module reads a credential's storage.** The Providers tab
 *   asks {@link CredentialStore.state}; the clients ask {@link CredentialStore.resolve}.
 */

import type { PluginSettings, ProviderSettingsMap } from "../shared/types";

/** The providers that authenticate with a credential we hold. */
export type KeyedProvider = "anthropic" | "openai";

export const KEYED_PROVIDERS: readonly KeyedProvider[] = ["anthropic", "openai"];

/**
 * Why {@link CredentialStore.resolve} would return null. Three states rather than
 * two, because a stored id is not evidence of a usable credential: Obsidian's
 * Keychain tab deletes a secret with no confirmation and no check for who is using
 * it, and `SecretComponent` renders that dangling id identically to "never
 * configured". Only the surrounding card can tell the two apart.
 */
export type CredentialState = "ok" | "unlinked" | "missing";

/** Resolves a credential at the moment of use, or null when there is none. */
export type CredentialResolver = () => string | null;

export interface CredentialStore {
  /** The credential, or null when nothing is linked or the linked secret is gone. */
  resolve(provider: KeyedProvider): string | null;
  /** Why resolve() would return null. For the Providers tab; nothing else may branch on it. */
  state(provider: KeyedProvider): CredentialState;
  /**
   * Retire a provider's legacy plaintext, if any, now that a linked secret resolves on its own.
   * Returns whether anything was retired. The next save then writes no plaintext.
   */
  retireLegacyKeyIfLinked(provider: KeyedProvider): boolean;
  /**
   * The blob `saveData` should write. Normally the settings themselves; after a
   * failed migration it re-attaches the legacy plaintext for the affected providers,
   * so the next save cannot scrub the very key the failure preserved. See
   * {@link SecretStorageCredentialStore} for why that is not the migration's job.
   */
  withLegacyOverlay(settings: PluginSettings): Record<string, unknown>;
}

/**
 * Thrown when a request is about to be made and no credential resolves. This is a
 * normal runtime state, not a configuration error: the user can delete the secret
 * from Obsidian's Keychain tab at any moment, so a key that was present when the
 * client was built may be gone by the time it is used. Constructing a client
 * therefore never checks, and every request does.
 */
export class MissingCredentialError extends Error {
  constructor(providerLabel: string) {
    super(`${providerLabel} API key not configured. Add your key in Settings → Providers.`);
    this.name = "MissingCredentialError";
  }
}

/**
 * Secret ids, derived from the plugin id in `manifest.json`, which is permanent
 * after first release and is the least collision-prone name we own. Secrets are
 * shared across every plugin in the vault, so the id is a name in someone else's
 * namespace. Written once here so a future keyed provider cannot spell it
 * differently. Both satisfy Obsidian's `/^[a-z0-9-]+$/` with its 64-character ceiling.
 */
const SECRET_ID_PREFIX = "writing-assistant-chat";

export const SECRET_IDS: Record<KeyedProvider, string> = {
  anthropic: `${SECRET_ID_PREFIX}-anthropic`,
  openai: `${SECRET_ID_PREFIX}-openai`,
};

/**
 * The slice of `app.secretStorage` this module uses, named after Obsidian's own
 * methods so `App.secretStorage` satisfies it structurally with no adapter to
 * mis-wire. Deliberately excludes everything present at runtime but absent from the
 * published typings (`peekSecret`, `deleteSecret`, `validateId`, and the rest).
 *
 * The whole API is synchronous, which is the single most load-bearing fact about
 * this work: no consumer of a credential becomes async.
 *
 * `setSecret` throws in exactly two cases, with no storage adapter and on an id
 * failing `/^[a-z0-9-]+$/` with a 64-character ceiling. We are desktop-only and we
 * author the id, so in practice neither fires, which is precisely why the
 * migration's failure path is covered by tests rather than by a comment.
 */
export interface SecretWriter {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
  listSecrets(): string[];
}

/**
 * Resolves credentials from Obsidian's secret storage, falling back to a
 * session-only overlay for any provider whose load migration could not relocate its
 * key.
 *
 * The overlay is the part that is easy to miss. Fail-closed reads as a property of
 * the migration, but the migration is not what deletes the plaintext: normalization
 * is. `normalizePluginSettings` builds a fresh object holding only known fields, so
 * the first save after a *failed* migration would scrub the very key the failure was
 * meant to preserve, triggered by any settings change anywhere in the app.
 * {@link withLegacyOverlay} re-attaches it at the save boundary, and nothing reads
 * the overlay except {@link resolve} and that one write. It holds nothing when
 * migration succeeded, and it empties the moment a later launch migrates or the user
 * links a secret by hand.
 */
export class SecretStorageCredentialStore implements CredentialStore {
  /** Plaintext kept alive for this session, for providers whose migration did not succeed. */
  private readonly legacyOverlay = new Map<KeyedProvider, string>();

  constructor(
    private readonly secrets: SecretWriter,
    private readonly getProviderSettings: () => ProviderSettingsMap,
    retainedLegacyKeys?: ReadonlyMap<KeyedProvider, string>,
  ) {
    if (retainedLegacyKeys) {
      for (const [provider, key] of retainedLegacyKeys) this.legacyOverlay.set(provider, key);
    }
  }

  resolve(provider: KeyedProvider): string | null {
    const id = this.getProviderSettings()[provider].apiKeySecretId;
    if (id.length > 0) {
      const secret = this.secrets.getSecret(id);
      if (secret) return secret;
    }
    return this.legacyOverlay.get(provider) ?? null;
  }

  /**
   * Mirrors {@link resolve} exactly, so the two can never disagree: anything that
   * resolves is "ok", including a dangling id whose provider still works through the
   * overlay.
   */
  state(provider: KeyedProvider): CredentialState {
    const id = this.getProviderSettings()[provider].apiKeySecretId;
    if (id.length === 0) {
      return this.legacyOverlay.has(provider) ? "ok" : "unlinked";
    }
    if (this.secrets.getSecret(id)) return "ok";
    return this.legacyOverlay.has(provider) ? "ok" : "missing";
  }

  /**
   * The other half of "one click resolves it permanently". A refused or failed migration keeps the
   * plaintext alive in the overlay, so once the user links a secret that resolves on its own, the
   * overlay is dead weight and the next save is what finally removes the key from the vault.
   * Without this the plaintext would be re-attached on every save until the next launch, and the
   * card would keep reporting a problem the user has already fixed.
   */
  retireLegacyKeyIfLinked(provider: KeyedProvider): boolean {
    const id = this.getProviderSettings()[provider].apiKeySecretId;
    if (id.length === 0 || !this.secrets.getSecret(id)) return false;
    return this.legacyOverlay.delete(provider);
  }

  withLegacyOverlay(settings: PluginSettings): Record<string, unknown> {
    if (this.legacyOverlay.size === 0) return { ...settings };
    const providerSettings: Record<string, unknown> = { ...settings.providerSettings };
    for (const [provider, apiKey] of this.legacyOverlay) {
      providerSettings[provider] = { ...settings.providerSettings[provider], apiKey };
    }
    return { ...settings, providerSettings };
  }
}

// ---------------------------------------------------------------------------
// The load migration (ADR-0039 part 3)
// ---------------------------------------------------------------------------

export type CredentialMigrationResult =
  /** A plaintext key was written to secret storage, verified, and scrubbed from the blob. */
  | "migrated"
  /** The credential was already in secret storage under a linked id; only the scrub ran. */
  | "adopted"
  /** Our id is held by a secret we did not write. Refused; the plaintext stays. */
  | "collision"
  /** `setSecret` threw, or the value did not read back. The plaintext stays. */
  | "failed"
  /** Nothing to do. */
  | "none";

export interface CredentialMigrationOutcome {
  provider: KeyedProvider;
  result: CredentialMigrationResult;
  /** Present on "failed": the thrown message, or how the round-trip disagreed. */
  error?: string;
}

export interface CredentialMigration {
  /** The blob to normalize and persist. Scrubbed for every provider that succeeded. */
  raw: Record<string, unknown> | null;
  outcomes: CredentialMigrationOutcome[];
  /** Whether the blob changed and is worth saving. */
  changed: boolean;
  /** Plaintext that survived, keyed by provider: the session overlay's seed. */
  retained: Map<KeyedProvider, string>;
}

/** The legacy plaintext key on a raw persisted provider record, or null. */
function readLegacyKey(providerRecord: unknown): string | null {
  if (typeof providerRecord !== "object" || providerRecord === null) return null;
  const key = (providerRecord as Record<string, unknown>).apiKey;
  return typeof key === "string" && key.length > 0 ? key : null;
}

/** The stored secret id on a raw persisted provider record, or "". */
function readSecretId(providerRecord: unknown): string {
  if (typeof providerRecord !== "object" || providerRecord === null) return "";
  const id = (providerRecord as Record<string, unknown>).apiKeySecretId;
  return typeof id === "string" ? id : "";
}

/**
 * Relocate any plaintext provider key in a raw persisted blob into secret storage,
 * then scrub it. Pure over its two inputs and importing nothing from `obsidian`, so
 * it is exercised with a fake {@link SecretWriter} rather than a fake `App`.
 *
 * Per provider the order is write, verify, adopt, and only then scrub. Any throw or
 * mismatch leaves the plaintext in place, writes no id, and records a failure: a
 * migration that scrubs first and fails at the write destroys a credential the user
 * may not have stored anywhere else. It retries on every launch, so a transient
 * failure heals itself with no user action.
 *
 * Runs before `normalizePluginSettings`, so normalization sees a blob that already
 * carries ids.
 */
export function migrateProviderCredentials(
  raw: Record<string, unknown> | null,
  secrets: SecretWriter,
): CredentialMigration {
  const retained = new Map<KeyedProvider, string>();
  const nothingToDo: CredentialMigration = {
    raw,
    outcomes: KEYED_PROVIDERS.map((provider) => ({ provider, result: "none" as const })),
    changed: false,
    retained,
  };

  if (raw === null) return nothingToDo;
  const providerSettings = raw.providerSettings;
  if (typeof providerSettings !== "object" || providerSettings === null) return nothingToDo;
  const providers = providerSettings as Record<string, unknown>;

  const outcomes: CredentialMigrationOutcome[] = [];
  let changed = false;

  for (const provider of KEYED_PROVIDERS) {
    const record = providers[provider];
    const legacyKey = readLegacyKey(record);
    if (legacyKey === null) {
      outcomes.push({ provider, result: "none" });
      continue;
    }

    const { outcome, adoptedId } = relocate(provider, record, legacyKey, secrets);
    outcomes.push(outcome);

    // The scrub, and only the scrub. Nothing above this line touched the blob, and
    // the id is written in the same step, so the blob can never end up scrubbed with
    // nothing pointing at the relocated secret.
    if (adoptedId !== null) {
      const updated = { ...(record as Record<string, unknown>) };
      updated.apiKeySecretId = adoptedId;
      delete updated.apiKey;
      providers[provider] = updated;
      changed = true;
    } else {
      retained.set(provider, legacyKey);
    }
  }

  return { raw, outcomes, changed, retained };
}

/**
 * One provider's relocation: it decides but never mutates, so the caller can do the
 * scrub and the id write as one step. `adoptedId` is the id the blob should end up
 * pointing at, or null to leave the blob alone. Returning the id rather than
 * deriving it from the result is what makes "scrubbed with nothing pointing at the
 * secret" unrepresentable.
 */
function relocate(
  provider: KeyedProvider,
  record: unknown,
  legacyKey: string,
  secrets: SecretWriter,
): { outcome: CredentialMigrationOutcome; adoptedId: string | null } {
  // The user already linked a secret by hand, which is how a refused migration is
  // meant to be resolved permanently. Without this clause that one click resolves
  // nothing: the plaintext would survive every relaunch behind an id that resolves
  // perfectly well, which is the outcome this whole exercise exists to prevent.
  const linkedId = readSecretId(record);
  if (linkedId.length > 0 && secrets.getSecret(linkedId) !== null) {
    return { outcome: { provider, result: "adopted" }, adoptedId: linkedId };
  }

  const id = SECRET_IDS[provider];

  // Secrets are shared with every plugin in the vault, so our id may already be
  // taken. Because reads are public we can tell our own previous run from someone
  // else's secret, and only the second is a collision. Adopting a value we did not
  // write would silently send an unknown credential to a provider, and suffixing
  // would leave two near-identical entries in the user's keychain forever, so this
  // refuses through the failure path that already exists and lets the user resolve
  // it in one click.
  if (secrets.listSecrets().includes(id)) {
    return secrets.getSecret(id) === legacyKey
      ? { outcome: { provider, result: "adopted" }, adoptedId: id }
      : { outcome: { provider, result: "collision" }, adoptedId: null };
  }

  try {
    secrets.setSecret(id, legacyKey);
  } catch (error) {
    return {
      outcome: {
        provider,
        result: "failed",
        error: error instanceof Error ? error.message : String(error),
      },
      adoptedId: null,
    };
  }

  // A value that did not round-trip is a failure, not a success.
  if (secrets.getSecret(id) !== legacyKey) {
    return {
      outcome: { provider, result: "failed", error: "The stored secret did not read back." },
      adoptedId: null,
    };
  }

  return { outcome: { provider, result: "migrated" }, adoptedId: id };
}

/**
 * Whether a raw persisted provider record still carries a usable credential, by id
 * or by surviving plaintext. Enablement gates on this rather than on secret storage,
 * so normalization stays pure and the settings suite runs without an `App`.
 */
export function hasLinkedCredential(providerRecord: unknown): boolean {
  return readSecretId(providerRecord).length > 0 || readLegacyKey(providerRecord) !== null;
}

import { SecretComponent, setIcon } from "obsidian";
import type WritingAssistantChat from "../main";
import type { CustomModelEntry, ModelRole, ProviderOption } from "../shared/types";
import type {
  CredentialMigrationOutcome,
  CredentialState,
  KeyedProvider,
} from "../providers/credentials";
import { SECRET_IDS } from "../providers/credentials";
import { normalizeLMStudioBaseUrl } from "../api";
import { reportIfRejected, voidAsync } from "../asyncCallbacks";
import { PROVIDER_DESCRIPTORS, PROVIDER_ICONS } from "../providers/descriptors";
import { getCatalogEntries } from "../providers/catalog";
import {
  getSelectableCompletionModels,
  getSelectableEmbeddingModels,
} from "../providers/selectableModels";
import { PROVIDER_OPTIONS } from "../shared/modelKeys";
import { CLAUDE_CODE_SETUP_URL } from "../services/ClaudeCodeService";
import type { ClaudeCodeDetection } from "../services/ClaudeCodeService";
import { ApiKeysDisclaimerModal } from "./modals";
import { Button, createSettingsSection, Dropdown, SettingItem, TextInput, Toggle } from "./ui";

/**
 * The Providers tab: one expandable card per provider, replacing the
 * Completion Models / Embedding Models tabs and the General tab's API-keys
 * section. Every provider is toggle + catalog: cloud catalogs ship with the
 * release (providers/catalog), the local catalog is live discovery cached as
 * last-seen. Nobody authors model rows; the custom-model list on cloud cards
 * is the escape hatch for fine-tunes and uncurated ids.
 */

/** Expansion survives the tab's full re-renders within a settings session. */
const expandedProviders = new Set<ProviderOption>();

/**
 * Health dot semantics (independent of the enable toggle, matching the
 * reference row anatomy): ok = enabled and contributing models, warn = off by
 * choice or nothing discovered yet, error = blocked (missing key / CLI),
 * unknown = still probing.
 */
type ProviderDot = "ok" | "warn" | "error" | "unknown";

interface ProviderHeaderState {
  dot: ProviderDot;
  status: string;
  /** Small muted chip after the name (e.g. the detected CLI version). */
  version?: string;
}

function formatContextSize(tokens?: number): string | null {
  if (!tokens || tokens <= 0) return null;
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M context`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K context`;
  return `${tokens} context`;
}

/** `claude --version` reports "2.1.201 (Claude Code)"; the parenthetical is redundant next to the provider name. */
function cleanCliVersion(version: string): string {
  return version.replace(/\s*\(.*\)\s*$/, "");
}

/**
 * Whether this provider's credential resolves right now. Keyless providers are
 * always "ok": they have nothing to resolve.
 *
 * A stored id is not evidence of a usable credential, because the user can delete
 * the secret from Obsidian's Keychain tab without reference to us, so this is a
 * runtime resolution rather than a string-length test (ADR-0039 part 2). Resolving
 * on every re-render is cheap: the one side effect of `getSecret` is an access
 * timestamp throttled to once per id per five minutes, so a resolution inside that
 * window is an object property read.
 */
function credentialState(plugin: WritingAssistantChat, provider: ProviderOption): CredentialState {
  if (provider !== "anthropic" && provider !== "openai") return "ok";
  return plugin.services.credentials.state(provider);
}

/**
 * What this launch's credential migration did to a provider, when that is something
 * the user needs to act on. A refused or failed relocation is reported here and
 * nowhere else: the provider keeps working through the session overlay, so a startup
 * modal would be alarming about something that is not broken, and this card is where
 * the Link control that fixes it permanently already sits.
 */
function unresolvedMigration(
  plugin: WritingAssistantChat,
  provider: ProviderOption,
): CredentialMigrationOutcome | null {
  const outcome = plugin.credentialMigration.find((entry) => entry.provider === provider);
  if (!outcome) return null;
  return outcome.result === "collision" || outcome.result === "failed" ? outcome : null;
}

/**
 * Copy for the API-key row. It claims exactly what ADR-0039 permits and no more:
 * relocation out of the vault is unconditional, encryption at rest is Obsidian's and
 * only where the OS provides a keystore, and we never encrypt anything ourselves.
 *
 * When a relocation was refused or failed, the row says so here rather than in the
 * status line: the Link control that fixes it permanently is right beside this text,
 * which is what makes the state actionable in place instead of merely reported.
 */
function keyRowDesc(plugin: WritingAssistantChat, provider: KeyedProvider): string {
  const unresolved = unresolvedMigration(plugin, provider);
  if (unresolved?.result === "collision") {
    return (
      `This key is still stored in this vault. Moving it was refused because a secret ` +
      `named ${SECRET_IDS[provider]} already exists and is not ours to overwrite. ` +
      `Link a key to finish moving it out.`
    );
  }
  if (unresolved) {
    return (
      "This key is still stored in this vault. It could not be moved to Obsidian's " +
      "keychain, so it stays here and keeps working. Link a key to finish moving it out."
    );
  }
  return (
    "Stored in Obsidian's keychain, outside your vault, encrypted where your OS " +
    "supports it. Linking a key enables the provider."
  );
}

/** Models this provider would contribute to selection (catalog/cache + custom). */
function providerModelCount(plugin: WritingAssistantChat, provider: ProviderOption): number {
  const custom = plugin.settings.customModels[provider]?.length ?? 0;
  if (provider === "lmstudio") {
    const cache = plugin.settings.lmStudioModelCache;
    return cache.completion.length + cache.embedding.length + custom;
  }
  return getCatalogEntries(provider).length + custom;
}

async function reconfigureKnowledgeServices(plugin: WritingAssistantChat): Promise<void> {
  const s = plugin.settings;
  await plugin.services.reconfigureRag(s.rag, getSelectableEmbeddingModels(s), s.providerSettings);
  await plugin.services.reconfigureGraph(
    s.knowledgeGraph,
    getSelectableCompletionModels(s),
    getSelectableEmbeddingModels(s),
    s.providerSettings,
  );
}

export function renderProvidersTab(
  container: HTMLElement,
  plugin: WritingAssistantChat,
  refresh: () => void,
): () => void {
  let disposed = false;

  // The page is a single list, but it still opens with a section card: every other settings page
  // heads its content with one, and a page that drops straight into its own chrome reads as a
  // different surface rather than a quieter one.
  const section = createSettingsSection(
    container,
    "Model providers",
    "Enable the LLM providers you use and manage their credentials and models in one place.",
    { icon: "plug" },
  );

  const listEl = section.bodyEl.createDiv({ cls: "lmsa-provider-cards" });

  for (const provider of PROVIDER_OPTIONS) {
    renderProviderCard(listEl, plugin, provider, refresh, () => disposed);
  }

  // Secrets are user-managed and shared: Obsidian's own Keychain tab can delete the
  // one a card is pointing at, with no confirmation and no check for who is using
  // it. Re-render on that so an open card cannot keep claiming a key that is gone.
  // A full refresh, not a header sync, because SecretComponent reads its value once
  // at setValue and cannot repaint itself.
  const onSecretsChanged = () => {
    if (!disposed) refresh();
  };
  plugin.app.secretStorage.on("changed", onSecretsChanged);

  // Prose, so it stays in the body: the footer is a right-aligned row for buttons.
  const footnote = section.bodyEl.createEl("p", { cls: "lmsa-provider-footnote" });
  footnote.setText(
    "Cloud model catalogs ship with the plugin and refresh with each release. Local models are discovered live from LM Studio.",
  );

  return () => {
    disposed = true;
    plugin.app.secretStorage.off("changed", onSecretsChanged);
  };
}

function renderProviderCard(
  container: HTMLElement,
  plugin: WritingAssistantChat,
  provider: ProviderOption,
  refresh: () => void,
  isDisposed: () => boolean,
): void {
  const descriptor = PROVIDER_DESCRIPTORS[provider];
  const settings = plugin.settings.providerSettings[provider];

  const card = container.createDiv({ cls: "lmsa-provider-card" });

  // ── Header: dotted icon + name/version + status line + chevron + toggle ──
  const header = card.createDiv({ cls: "lmsa-provider-card-header" });
  const iconWrap = header.createDiv({ cls: "lmsa-provider-card-iconwrap" });
  const iconEl = iconWrap.createDiv({ cls: "lmsa-provider-card-icon" });
  iconEl.addClass(`lmsa-brand-tint-${provider}`);
  setIcon(iconEl, PROVIDER_ICONS[provider]);
  const dotEl = iconWrap.createSpan({ cls: "lmsa-provider-status-dot is-unknown" });

  const infoEl = header.createDiv({ cls: "lmsa-provider-card-info" });
  const nameRow = infoEl.createDiv({ cls: "lmsa-provider-card-name-row" });
  nameRow.createSpan({ cls: "lmsa-provider-card-name", text: descriptor.label });
  const versionEl = nameRow.createSpan({
    cls: "lmsa-provider-card-version lmsa-hidden",
  });
  const statusEl = infoEl.createDiv({ cls: "lmsa-provider-card-status" });

  const chevronEl = header.createSpan({ cls: "lmsa-provider-card-chevron" });
  setIcon(chevronEl, "chevron-down");

  // The toggle lives in the header but must not toggle expansion.
  const toggleWrap = header.createDiv({ cls: "lmsa-provider-card-toggle" });
  toggleWrap.addEventListener("click", (event) => event.stopPropagation());
  const toggle = new Toggle(toggleWrap);

  // Grid-track wrapper so expansion animates height (0fr -> 1fr). The clip
  // layer between track and body must stay padding- and border-free: a grid
  // track cannot shrink below an item's padding+border floor, so padding on
  // the clipped element would leave a visible strip when collapsed.
  const bodyWrap = card.createDiv({ cls: "lmsa-provider-card-bodywrap" });
  const bodyClip = bodyWrap.createDiv({ cls: "lmsa-provider-card-bodyclip" });
  const body = bodyClip.createDiv({ cls: "lmsa-provider-card-body" });

  // Claude Code health is async: probe once per card, share the promise with
  // the body, and re-sync the header when the result lands.
  let detection: ClaudeCodeDetection | "pending" | null = null;
  let detectionPromise: Promise<ClaudeCodeDetection> | null = null;
  if (provider === "claudecode") {
    detection = "pending";
    detectionPromise = plugin.services.claudeCode.detect();
    void detectionPromise.then((result) => {
      if (isDisposed()) return;
      detection = result;
      syncHeader();
    });
  }

  const syncHeader = (): void => {
    const keyed = descriptor.authType === "api-key";
    toggle.setValue(settings.enabled);
    // Gated on linkage, matching what normalization clamps on. A dangling id leaves
    // the toggle live: the provider is configured, its secret is just missing, and
    // re-linking is the fix rather than re-enabling.
    toggle.setDisabled(keyed && credentialState(plugin, provider) === "unlinked");
    card.toggleClass("is-off", !settings.enabled);

    const state = buildHeaderState(plugin, provider, detection);
    statusEl.setText(state.status);
    dotEl.removeClass("is-ok", "is-warn", "is-error", "is-unknown");
    dotEl.addClass(`is-${state.dot}`);
    versionEl.toggleClass("lmsa-hidden", !state.version);
    if (state.version) versionEl.setText(state.version);
  };

  const syncExpansion = (): void => {
    const expanded = expandedProviders.has(provider);
    card.toggleClass("is-expanded", expanded);
    // Collapsed content is clipped, not display:none, so keep it out of the
    // tab order while hidden.
    bodyWrap.inert = !expanded;
  };

  header.addEventListener("click", () => {
    if (expandedProviders.has(provider)) expandedProviders.delete(provider);
    else expandedProviders.add(provider);
    syncExpansion();
  });

  const applyEnabled = async (value: boolean): Promise<void> => {
    settings.enabled = value;
    await plugin.saveSettings();
    // Enablement changes what RAG / graph may select from; keep them honest.
    await reconfigureKnowledgeServices(plugin);
    syncHeader();
  };

  /**
   * The one place a cloud provider is allowed to turn on, and therefore the only
   * gate the privacy disclaimer needs. Linking a secret in Obsidian's keychain
   * transmits nothing, and a provider cannot be used without being enabled, so
   * entry is no longer gated; but linking also flips the provider on, which would
   * otherwise let a first-time user enable a cloud provider having never seen the
   * disclaimer. Routing that flip through here closes it. Declining or closing the
   * modal leaves the provider off (revert the optimistic visual flip).
   */
  const requestEnabled = async (value: boolean): Promise<void> => {
    if (value && descriptor.kind === "cloud" && !plugin.settings.apiKeysDisclaimerAccepted) {
      toggle.setValue(false);
      new ApiKeysDisclaimerModal(plugin.app, plugin, () => {
        void applyEnabled(true);
      }).open();
      return;
    }
    await applyEnabled(value);
  };

  toggle.onChange(requestEnabled);

  // ── Body, driven by the descriptor rather than hardcoded per provider ──
  if (provider === "lmstudio") {
    renderLmStudioBody(body, plugin, refresh);
  } else if (descriptor.authType === "api-key") {
    renderKeyedCloudBody(
      body,
      plugin,
      provider as "anthropic" | "openai",
      syncHeader,
      requestEnabled,
      applyEnabled,
      refresh,
    );
  } else if (detectionPromise) {
    renderClaudeCodeBody(body, plugin, detectionPromise, refresh, isDisposed);
  }

  syncHeader();
  syncExpansion();
}

function buildHeaderState(
  plugin: WritingAssistantChat,
  provider: ProviderOption,
  detection: ClaudeCodeDetection | "pending" | null,
): ProviderHeaderState {
  const descriptor = PROVIDER_DESCRIPTORS[provider];
  const enabled = plugin.settings.providerSettings[provider].enabled;
  const count = providerModelCount(plugin, provider);
  const models = `${count} model${count === 1 ? "" : "s"}`;

  if (descriptor.authType === "api-key") {
    // A relocation we refused or could not complete. The provider still works, so
    // this is quiet and actionable rather than alarming: the Link control below
    // resolves it permanently in one click.
    // Short enough to survive the status line's truncation. The why and the what-to-do
    // live in the key row's description, which has room for them.
    if (unresolvedMigration(plugin, provider)) {
      return { dot: "warn", status: "Your key is still stored in this vault" };
    }

    const state = credentialState(plugin, provider);
    if (state === "unlinked") return { dot: "error", status: "Needs API key" };
    // A linked id whose secret is gone. Distinct from "never configured", which the
    // secret picker itself renders identically, so only this line can tell them apart.
    if (state === "missing") {
      return { dot: "error", status: "Linked key is missing from Obsidian's keychain" };
    }
  }

  if (provider === "lmstudio") {
    const discovered = plugin.settings.lmStudioModelCache.discoveredAt !== null;
    if (!enabled) return { dot: "warn", status: "Disabled" };
    if (!discovered || count === 0) return { dot: "warn", status: "No models discovered yet" };
    return { dot: "ok", status: `Local server · ${models} last seen` };
  }

  if (provider === "claudecode") {
    if (detection === "pending" || detection === null) {
      return { dot: "unknown", status: "Checking for the Claude Code CLI…" };
    }
    if (!detection.installed) {
      return {
        dot: "error",
        status: "Not found · the Claude Code CLI is not installed or not on the system path",
      };
    }
    const version = detection.version ? `v${cleanCliVersion(detection.version)}` : undefined;
    if (!enabled) return { dot: "warn", status: "Disabled", version };
    return {
      dot: "ok",
      status: `Authenticated via your Claude Code login · ${models} available in chat`,
      version,
    };
  }

  if (!enabled) return { dot: "warn", status: "Disabled · API key kept" };
  return { dot: "ok", status: `API key linked · ${models} available in chat` };
}

// ---------------------------------------------------------------------------
// Cloud cards (Anthropic, OpenAI): linked API key + curated catalog + custom ids
// ---------------------------------------------------------------------------

function renderKeyedCloudBody(
  body: HTMLElement,
  plugin: WritingAssistantChat,
  provider: "anthropic" | "openai",
  syncHeader: () => void,
  requestEnabled: (value: boolean) => Promise<void>,
  applyEnabled: (value: boolean) => Promise<void>,
  refresh: () => void,
): void {
  const providerSettings = plugin.settings.providerSettings[provider];

  const keyItem = new SettingItem(body).setName("API key").setDesc(keyRowDesc(plugin, provider));

  // Obsidian's own secret picker. Our SettingItem is homegrown rather than an
  // Obsidian Setting, so there is no addComponent(); the component takes a container
  // element directly. It is wrapped so the three unclassed children it appends (a
  // warning icon, a value div, and a bare <button> wearing Obsidian's full base
  // button chrome) can be styled without reaching every other control in the row.
  const secretWrap = keyItem.controlEl.createDiv({ cls: "lmsa-secret-control" });
  const secret = new SecretComponent(plugin.app, secretWrap);
  secret.setValue(providerSettings.apiKeySecretId);

  const handleSecretChange = async (value: string | null): Promise<void> => {
    const id = (value ?? "").trim();
    const hadId = providerSettings.apiKeySecretId.length > 0;
    providerSettings.apiKeySecretId = id;
    // Linking a working secret retires any plaintext a refused or failed relocation kept alive, so
    // this save is the one that finally removes it from the vault. Before the save, so the save
    // itself carries the scrub.
    const migrationResolved = plugin.resolveCredentialMigration(provider);
    await plugin.saveSettings();
    plugin.services.modelAvailability.invalidate();

    // Linking is an unambiguous statement of intent: unlock and flip on in the same
    // gesture, through the path that carries the privacy disclaimer. Unlinking
    // re-locks the toggle.
    if (id.length > 0 && !hadId) await requestEnabled(true);
    else if (id.length === 0) await applyEnabled(false);

    // The row's description is built once per render, so a resolved relocation needs a
    // rebuild rather than a header sync to stop describing a problem that is now fixed.
    if (migrationResolved) refresh();
    else syncHeader();
  };

  // Typed against `string | null` rather than the published `(value: string)`: the
  // unlink control calls back with null, and unguarded, so a handler written to the
  // signature would mishandle normal use. A wider parameter is still assignable.
  secret.onChange((value: string | null) =>
    reportIfRejected(handleSecretChange(value), "Failed to save the API key link."),
  );

  if (provider === "openai") {
    new SettingItem(body)
      .setName("Base URL")
      .setDesc("Override for OpenAI-compatible endpoints.")
      .addText((text) => {
        text.setPlaceholder("https://api.openai.com/v1");
        text.setValue(plugin.settings.providerSettings.openai.baseUrl);
        text.onChange(async (value) => {
          plugin.settings.providerSettings.openai.baseUrl = value.trim();
          await plugin.saveSettings();
          plugin.services.modelAvailability.invalidate();
        });
      });
  }

  renderCatalogList(body, plugin, provider);
  renderCustomModels(body, plugin, provider, refresh);
}

// ---------------------------------------------------------------------------
// LM Studio: connection + live-discovered library, no profiles
// ---------------------------------------------------------------------------

function renderLmStudioBody(
  body: HTMLElement,
  plugin: WritingAssistantChat,
  refresh: () => void,
): void {
  const lm = plugin.settings.providerSettings.lmstudio;

  new SettingItem(body)
    .setName("Server URL")
    .setDesc("The LM Studio local server address.")
    .addText((text) => {
      text.setPlaceholder("http://localhost:1234/v1");
      text.setValue(lm.baseUrl);
      text.onChange(async (value) => {
        lm.baseUrl = normalizeLMStudioBaseUrl(value);
        await plugin.saveSettings();
        plugin.services.modelAvailability.invalidate();
      });
    });

  new SettingItem(body)
    .setName("Bypass CORS")
    .setDesc("Connect through the plugin's local transport instead of the browser fetch path.")
    .addToggle((toggle) => {
      toggle.setValue(lm.bypassCors);
      toggle.onChange(async (value) => {
        lm.bypassCors = value;
        await plugin.saveSettings();
        plugin.services.modelAvailability.invalidate();
      });
    });

  // ── Discovered models ──
  const section = body.createDiv({ cls: "lmsa-provider-models" });
  const headerRow = section.createDiv({ cls: "lmsa-provider-models-header" });
  headerRow.createSpan({ cls: "lmsa-provider-models-title", text: "Models" });

  const cache = plugin.settings.lmStudioModelCache;
  headerRow.createSpan({ cls: "lmsa-provider-models-meta" });

  new Button(headerRow).setButtonText("Refresh").onClick(async () => {
    try {
      await plugin.services.modelAvailability.refreshLocalModels({ forceRefresh: true });
    } catch {
      // Unreachable server keeps the last-seen list; the meta line says when
      // it was captured, which is the honest state.
    }
    refresh();
  });

  const rows: Array<{ name: string; modelId: string; role: ModelRole }> = [
    ...cache.completion.map((m) => ({ name: m.name, modelId: m.modelId, role: "completion" as const })),
    ...cache.embedding.map((m) => ({ name: m.name, modelId: m.modelId, role: "embedding" as const })),
  ];

  if (rows.length === 0) {
    section.createEl("p", {
      cls: "lmsa-provider-models-empty",
      text: "No models seen yet. Start the LM Studio server and refresh.",
    });
    return;
  }

  const list = section.createDiv({ cls: "lmsa-item-list" });
  for (const row of rows) {
    const rowEl = list.createDiv({ cls: "lmsa-item-row lmsa-provider-model-row" });
    const info = rowEl.createDiv({ cls: "lmsa-item-info" });
    info.createDiv({ cls: "lmsa-provider-model-name", text: row.name });
    info.createDiv({ cls: "lmsa-provider-model-id", text: row.modelId });

    const badges = rowEl.createDiv({ cls: "lmsa-provider-model-badges" });
    badges.createSpan({ cls: "lmsa-provider-role-chip", text: row.role });
    const { state } = plugin.services.modelAvailability.getAvailability(row.modelId, "lmstudio");
    if (state === "loaded" || state === "unloaded") {
      badges.createSpan({
        cls: `lmsa-model-state-badge is-${state}`,
        text: state === "loaded" ? "loaded" : "unloaded",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Claude Code: CLI detection + curated aliases
// ---------------------------------------------------------------------------

function renderClaudeCodeBody(
  body: HTMLElement,
  plugin: WritingAssistantChat,
  detectionPromise: Promise<ClaudeCodeDetection>,
  refresh: () => void,
  isDisposed: () => boolean,
): void {
  const detectionItem = new SettingItem(body)
    .setName("Claude Code CLI")
    .setDesc(
      "Uses your existing Claude Code login; no API key is stored. Sessions mirror " +
        "conversation and tool-read vault content into ~/.claude under Claude Code's " +
        "own retention policy.",
    );
  const statusEl = detectionItem.controlEl.createSpan({
    cls: "lmsa-provider-detection",
    text: "Checking…",
  });

  void detectionPromise.then((detection) => {
    if (isDisposed()) return;
    if (detection.installed) {
      statusEl.setText(
        detection.version ? `Detected (v${cleanCliVersion(detection.version)})` : "Detected",
      );
      statusEl.addClass("is-ok");
    } else {
      statusEl.setText("Not detected");
      statusEl.addClass("is-missing");
      const link = detectionItem.descEl.createEl("a", {
        text: "Set up Claude Code",
        href: CLAUDE_CODE_SETUP_URL,
      });
      link.addClass("lmsa-provider-setup-link");
    }
  });

  new SettingItem(body)
    .setName("Claude binary path")
    .setDesc("Optional explicit path to the `claude` command. Leave empty to resolve from the system path.")
    .addText((text) => {
      text.setPlaceholder("Auto-detect");
      text.setValue(plugin.settings.providerSettings.claudecode.claudePath);
      text.onChange(async (value) => {
        plugin.settings.providerSettings.claudecode.claudePath = value.trim();
        await plugin.saveSettings();
      });
    });

  renderCatalogList(body, plugin, "claudecode");
  renderCustomModels(body, plugin, "claudecode", refresh);
}

// ---------------------------------------------------------------------------
// Shared: curated catalog list + custom-model escape hatch
// ---------------------------------------------------------------------------

function renderCatalogList(
  body: HTMLElement,
  plugin: WritingAssistantChat,
  provider: ProviderOption,
): void {
  const entries = getCatalogEntries(provider);
  if (entries.length === 0) return;

  const section = body.createDiv({ cls: "lmsa-provider-models" });
  const headerRow = section.createDiv({ cls: "lmsa-provider-models-header" });
  headerRow.createSpan({ cls: "lmsa-provider-models-title", text: "Models" });
  headerRow.createSpan({
    cls: "lmsa-provider-models-meta",
    text: "Built-in catalog",
  });

  const list = section.createDiv({ cls: "lmsa-item-list" });
  for (const entry of entries) {
    const rowEl = list.createDiv({ cls: "lmsa-item-row lmsa-provider-model-row" });
    const info = rowEl.createDiv({ cls: "lmsa-item-info" });
    info.createDiv({ cls: "lmsa-provider-model-name", text: entry.name });
    info.createDiv({ cls: "lmsa-provider-model-id", text: entry.modelId });

    const badges = rowEl.createDiv({ cls: "lmsa-provider-model-badges" });
    badges.createSpan({ cls: "lmsa-provider-role-chip", text: entry.role });
    const context = formatContextSize(entry.contextWindowSize);
    if (context) {
      badges.createSpan({ cls: "lmsa-provider-context-chip", text: context });
    }
  }
}

function renderCustomModels(
  body: HTMLElement,
  plugin: WritingAssistantChat,
  provider: ProviderOption,
  refresh: () => void,
): void {
  const section = body.createDiv({ cls: "lmsa-provider-models" });
  const headerRow = section.createDiv({ cls: "lmsa-provider-models-header" });
  headerRow.createSpan({ cls: "lmsa-provider-models-title", text: "Custom models" });
  headerRow.createSpan({
    cls: "lmsa-provider-models-meta",
    text: "For fine-tunes and ids the catalog does not carry.",
  });

  const existing = plugin.settings.customModels[provider] ?? [];
  if (existing.length > 0) {
    const list = section.createDiv({ cls: "lmsa-item-list" });
    existing.forEach((entry, index) => {
      const rowEl = list.createDiv({ cls: "lmsa-item-row lmsa-provider-model-row" });
      const info = rowEl.createDiv({ cls: "lmsa-item-info" });
      info.createDiv({ cls: "lmsa-provider-model-name", text: entry.name });
      info.createDiv({ cls: "lmsa-provider-model-id", text: entry.modelId });

      const badges = rowEl.createDiv({ cls: "lmsa-provider-model-badges" });
      badges.createSpan({ cls: "lmsa-provider-role-chip", text: entry.role });

      const removeBtn = rowEl.createEl("button", {
        cls: "lmsa-ui-btn lmsa-ui-btn-secondary lmsa-provider-remove-btn",
        attr: { "aria-label": "Remove custom model" },
      });
      setIcon(removeBtn, "trash-2");
      removeBtn.addEventListener("click", voidAsync(async () => {
        const entries = plugin.settings.customModels[provider] ?? [];
        entries.splice(index, 1);
        if (entries.length === 0) delete plugin.settings.customModels[provider];
        await plugin.saveSettings();
        await reconfigureKnowledgeServices(plugin);
        refresh();
      }, "Failed to remove the custom model."));
    });
  }

  // ── Add row ──
  const addRow = section.createDiv({ cls: "lmsa-provider-add-row" });
  const idInput = new TextInput(addRow).setPlaceholder("Model ID");
  const nameInput = new TextInput(addRow).setPlaceholder("Display name (optional)");

  // Only OpenAI serves both roles today; elsewhere the chip is fixed.
  let role: ModelRole = "completion";
  if (provider === "openai") {
    new Dropdown(addRow)
      .addOption("completion", "Completion")
      .addOption("embedding", "Embedding")
      .setValue("completion")
      .onChange((value) => {
        role = value as ModelRole;
      });
  }

  new Button(addRow).setButtonText("Add").onClick(async () => {
    const modelId = idInput.inputEl.value.trim();
    if (!modelId) return;
    const entry: CustomModelEntry = {
      modelId,
      name: nameInput.inputEl.value.trim() || modelId,
      role,
    };
    const entries = (plugin.settings.customModels[provider] ??= []);
    if (entries.some((existingEntry) => existingEntry.modelId === modelId && existingEntry.role === role)) {
      return;
    }
    entries.push(entry);
    await plugin.saveSettings();
    await reconfigureKnowledgeServices(plugin);
    refresh();
  });
}

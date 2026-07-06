import { setIcon } from "obsidian";
import type WritingAssistantChat from "../main";
import type { CustomModelEntry, ModelRole, ProviderOption } from "../shared/types";
import { normalizeLMStudioBaseUrl } from "../api";
import { PROVIDER_DESCRIPTORS } from "../providers/descriptors";
import { CATALOG_AS_OF, getCatalogEntries } from "../providers/catalog";
import {
  getSelectableCompletionModels,
  getSelectableEmbeddingModels,
} from "../providers/selectableModels";
import { PROVIDER_OPTIONS } from "../shared/modelKeys";
import { CLAUDE_CODE_SETUP_URL } from "../services/ClaudeCodeService";
import { ApiKeysDisclaimerModal } from "./modals";
import { Button, Dropdown, SettingItem, TextInput, Toggle } from "./ui";

/**
 * The Providers tab: one expandable card per provider, replacing the
 * Completion Models / Embedding Models tabs and the General tab's API-keys
 * section. Every provider is toggle + catalog: cloud catalogs ship with the
 * release (providers/catalog), the local catalog is live discovery cached as
 * last-seen. Nobody authors model rows; the custom-model list on cloud cards
 * is the escape hatch for fine-tunes and uncurated ids.
 */

const PROVIDER_ICONS: Record<ProviderOption, string> = {
  lmstudio: "cpu",
  anthropic: "sparkles",
  openai: "bot",
  claudecode: "terminal",
};

/** Expansion survives the tab's full re-renders within a settings session. */
const expandedProviders = new Set<ProviderOption>();

function formatContextSize(tokens?: number): string | null {
  if (!tokens || tokens <= 0) return null;
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M context`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K context`;
  return `${tokens} context`;
}

function hasApiKey(plugin: WritingAssistantChat, provider: ProviderOption): boolean {
  if (provider === "anthropic") return plugin.settings.providerSettings.anthropic.apiKey.length > 0;
  if (provider === "openai") return plugin.settings.providerSettings.openai.apiKey.length > 0;
  return true;
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
  const listEl = container.createDiv({ cls: "lmsa-provider-cards" });

  for (const provider of PROVIDER_OPTIONS) {
    renderProviderCard(listEl, plugin, provider, refresh, () => disposed);
  }

  const footnote = container.createEl("p", { cls: "lmsa-provider-footnote" });
  footnote.setText(
    `Cloud model catalogs ship with the plugin (as of ${CATALOG_AS_OF}) and refresh with each release. Local models are discovered live from LM Studio.`,
  );

  return () => {
    disposed = true;
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

  // ── Header: icon + name + status line + chevron + enable toggle ──
  const header = card.createDiv({ cls: "lmsa-provider-card-header" });
  const iconEl = header.createDiv({ cls: "lmsa-provider-card-icon" });
  setIcon(iconEl, PROVIDER_ICONS[provider]);

  const infoEl = header.createDiv({ cls: "lmsa-provider-card-info" });
  infoEl.createDiv({ cls: "lmsa-provider-card-name", text: descriptor.label });
  const statusEl = infoEl.createDiv({ cls: "lmsa-provider-card-status" });

  const chevronEl = header.createEl("span", { cls: "lmsa-provider-card-chevron" });

  // The toggle lives in the header but must not toggle expansion.
  const toggleWrap = header.createDiv({ cls: "lmsa-provider-card-toggle" });
  toggleWrap.addEventListener("click", (event) => event.stopPropagation());
  const toggle = new Toggle(toggleWrap);

  const body = card.createDiv({ cls: "lmsa-provider-card-body" });

  const syncHeader = (): void => {
    const keyed = descriptor.authType === "api-key";
    const keyPresent = hasApiKey(plugin, provider);
    toggle.setValue(settings.enabled);
    toggle.setDisabled(keyed && !keyPresent);
    card.toggleClass("is-off", !settings.enabled);
    statusEl.setText(buildStatusLine(plugin, provider));
  };

  const syncExpansion = (): void => {
    const expanded = expandedProviders.has(provider);
    body.toggleClass("lmsa-hidden", !expanded);
    card.toggleClass("is-expanded", expanded);
    chevronEl.empty();
    setIcon(chevronEl, expanded ? "chevron-up" : "chevron-down");
  };

  header.addEventListener("click", () => {
    if (expandedProviders.has(provider)) expandedProviders.delete(provider);
    else expandedProviders.add(provider);
    syncExpansion();
  });

  toggle.onChange(async (value) => {
    settings.enabled = value;
    await plugin.saveSettings();
    // Enablement changes what RAG / graph may select from; keep them honest.
    await reconfigureKnowledgeServices(plugin);
    syncHeader();
  });

  // ── Body, driven by the descriptor rather than hardcoded per provider ──
  if (provider === "lmstudio") {
    renderLmStudioBody(body, plugin, refresh);
  } else if (descriptor.authType === "api-key") {
    renderKeyedCloudBody(body, plugin, provider as "anthropic" | "openai", syncHeader, refresh);
  } else {
    renderClaudeCodeBody(body, plugin, refresh, isDisposed);
  }

  syncHeader();
  syncExpansion();
}

function buildStatusLine(plugin: WritingAssistantChat, provider: ProviderOption): string {
  const descriptor = PROVIDER_DESCRIPTORS[provider];
  const enabled = plugin.settings.providerSettings[provider].enabled;
  const count = providerModelCount(plugin, provider);
  const models = `${count} model${count === 1 ? "" : "s"}`;

  if (descriptor.authType === "api-key" && !hasApiKey(plugin, provider)) {
    return "Needs API key";
  }
  if (provider === "lmstudio") {
    const discovered = plugin.settings.lmStudioModelCache.discoveredAt !== null;
    if (!enabled) return "Disabled";
    return discovered ? `${models} last seen` : "No models discovered yet";
  }
  const auth = descriptor.authType === "api-key" ? "API key set" : "Uses your Claude Code login";
  return enabled ? `${auth} · ${models} available in chat` : `${auth} · disabled`;
}

// ---------------------------------------------------------------------------
// Cloud cards (Anthropic, OpenAI): inline API key + curated catalog + custom ids
// ---------------------------------------------------------------------------

function renderKeyedCloudBody(
  body: HTMLElement,
  plugin: WritingAssistantChat,
  provider: "anthropic" | "openai",
  syncHeader: () => void,
  refresh: () => void,
): void {
  const providerSettings = plugin.settings.providerSettings[provider];

  const keyItem = new SettingItem(body)
    .setName("API key")
    .setDesc("Stored locally in this vault and never shared. Saving a key enables the provider.");

  keyItem.addText((text) => {
    text.inputEl.type = "password";
    text.setPlaceholder(provider === "anthropic" ? "sk-ant-…" : "sk-…");
    text.setValue(providerSettings.apiKey);

    // The one-time privacy disclaimer gates key entry wherever it lives.
    text.inputEl.addEventListener("focus", () => {
      if (plugin.settings.apiKeysDisclaimerAccepted) return;
      text.inputEl.blur();
      new ApiKeysDisclaimerModal(plugin.app, plugin, () => {
        text.inputEl.focus();
      }).open();
    });

    text.onChange(async (value) => {
      const key = value.trim();
      const hadKey = providerSettings.apiKey.length > 0;
      providerSettings.apiKey = key;
      // Entering a key is an unambiguous statement of intent: unlock and flip
      // on in the same gesture. Clearing it re-locks the toggle.
      if (key.length > 0 && !hadKey) providerSettings.enabled = true;
      if (key.length === 0) providerSettings.enabled = false;
      await plugin.saveSettings();
      plugin.services.modelAvailability.invalidate();
      syncHeader();
    });
  });

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
  headerRow.createEl("span", { cls: "lmsa-provider-models-title", text: "Models" });

  const cache = plugin.settings.lmStudioModelCache;
  const metaEl = headerRow.createEl("span", { cls: "lmsa-provider-models-meta" });
  metaEl.setText(
    cache.discoveredAt !== null
      ? `Last discovered ${new Date(cache.discoveredAt).toLocaleString()}`
      : "Not discovered yet",
  );

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
    badges.createEl("span", { cls: "lmsa-provider-role-chip", text: row.role });
    const { state } = plugin.services.modelAvailability.getAvailability(row.modelId, "lmstudio");
    if (state === "loaded" || state === "unloaded") {
      badges.createEl("span", {
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
  refresh: () => void,
  isDisposed: () => boolean,
): void {
  const detectionItem = new SettingItem(body)
    .setName("Claude Code CLI")
    .setDesc("Uses your existing Claude Code login; no API key is stored.");
  const statusEl = detectionItem.controlEl.createEl("span", {
    cls: "lmsa-provider-detection",
    text: "Checking…",
  });

  void plugin.services.claudeCode.detect().then((detection) => {
    if (isDisposed()) return;
    if (detection.installed) {
      statusEl.setText(detection.version ? `Detected (v${detection.version})` : "Detected");
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
  headerRow.createEl("span", { cls: "lmsa-provider-models-title", text: "Models" });
  headerRow.createEl("span", {
    cls: "lmsa-provider-models-meta",
    text: `Built-in catalog, as of ${CATALOG_AS_OF}`,
  });

  const list = section.createDiv({ cls: "lmsa-item-list" });
  for (const entry of entries) {
    const rowEl = list.createDiv({ cls: "lmsa-item-row lmsa-provider-model-row" });
    const info = rowEl.createDiv({ cls: "lmsa-item-info" });
    info.createDiv({ cls: "lmsa-provider-model-name", text: entry.name });
    info.createDiv({ cls: "lmsa-provider-model-id", text: entry.modelId });

    const badges = rowEl.createDiv({ cls: "lmsa-provider-model-badges" });
    badges.createEl("span", { cls: "lmsa-provider-role-chip", text: entry.role });
    const context = formatContextSize(entry.contextWindowSize);
    if (context) {
      badges.createEl("span", { cls: "lmsa-provider-context-chip", text: context });
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
  headerRow.createEl("span", { cls: "lmsa-provider-models-title", text: "Custom models" });
  headerRow.createEl("span", {
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
      badges.createEl("span", { cls: "lmsa-provider-role-chip", text: entry.role });

      const removeBtn = rowEl.createEl("button", {
        cls: "lmsa-ui-btn lmsa-ui-btn-secondary lmsa-provider-remove-btn",
        attr: { "aria-label": "Remove custom model" },
      });
      setIcon(removeBtn, "trash-2");
      removeBtn.addEventListener("click", async () => {
        const entries = plugin.settings.customModels[provider] ?? [];
        entries.splice(index, 1);
        if (entries.length === 0) delete plugin.settings.customModels[provider];
        await plugin.saveSettings();
        await reconfigureKnowledgeServices(plugin);
        refresh();
      });
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

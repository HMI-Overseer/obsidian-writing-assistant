/**
 * Settings normalization / migration.
 *
 * Turns the untyped blob `Plugin.loadData()` returns (a `Partial<PluginSettings>`
 * from an older release, hand-edited JSON, or `null` on first run) into a fully
 * populated, type-correct {@link PluginSettings}. Every field is defaulted from
 * {@link DEFAULT_SETTINGS}, so a missing or wrong-typed value never crashes
 * downstream and an upgrade picks up new defaults transparently.
 *
 * Extracted from `main.ts` so the migration is unit-testable in isolation and the
 * plugin entry point stays thin (it just calls {@link normalizePluginSettings}).
 * Pure: no Obsidian, no disk, no plugin instance.
 */

import type {
  BenchmarkHistoryEntry,
  BenchmarkSettings,
  ChatHistory,
  CompletionModel,
  CustomCommand,
  CustomModelEntry,
  EmbeddingModel,
  KnowledgeGraphSettings,
  LmStudioModelCache,
  ModelRole,
  PluginSettings,
  ProviderOption,
  ProviderProfile,
  ProviderSettingsMap,
  RagSettings,
  ReasoningLevel,
} from "../shared/types";
import {
  DEFAULT_ACTIVE_PROFILE_IDS,
  DEFAULT_BENCHMARK_SETTINGS,
  DEFAULT_CHAT_HISTORY,
  DEFAULT_KNOWLEDGE_GRAPH_SETTINGS,
  DEFAULT_RAG_SETTINGS,
  DEFAULT_SETTINGS,
  MAX_BENCHMARK_HISTORY,
} from "../constants";
import { DEFAULT_VAULT_OP_POLICY, type Gate, type VaultOpPolicy } from "../vault-ops/gateway";
import { isReasoningLevel } from "../shared/reasoning";
import { PROVIDER_DESCRIPTORS } from "../providers/descriptors";
import { getCatalogEntries } from "../providers/catalog";
import { modelKey, parseModelKey } from "../shared/modelKeys";
import { normalizeChatHistory } from "../chat/conversation/conversationUtils";

export function normalizeKnowledgeGraphSettings(raw: unknown): KnowledgeGraphSettings {
  const data = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<KnowledgeGraphSettings>;
  return {
    enabled: typeof data.enabled === "boolean" ? data.enabled : DEFAULT_KNOWLEDGE_GRAPH_SETTINGS.enabled,
    activeCompletionModelId:
      typeof data.activeCompletionModelId === "string"
        ? data.activeCompletionModelId
        : DEFAULT_KNOWLEDGE_GRAPH_SETTINGS.activeCompletionModelId,
    activeEmbeddingModelId:
      typeof data.activeEmbeddingModelId === "string"
        ? data.activeEmbeddingModelId
        : DEFAULT_KNOWLEDGE_GRAPH_SETTINGS.activeEmbeddingModelId,
    excludePatterns: Array.isArray(data.excludePatterns)
      ? data.excludePatterns.filter((p): p is string => typeof p === "string")
      : [...DEFAULT_KNOWLEDGE_GRAPH_SETTINGS.excludePatterns],
  };
}

export function normalizeBenchmarkSettings(raw: unknown): BenchmarkSettings {
  const data = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<BenchmarkSettings>;
  const history = Array.isArray(data.history)
    ? data.history
        .filter(
          (e): e is BenchmarkHistoryEntry =>
            typeof e === "object" && e !== null &&
            typeof (e as BenchmarkHistoryEntry).id === "string" &&
            typeof (e as BenchmarkHistoryEntry).conditions === "object" &&
            Array.isArray((e as BenchmarkHistoryEntry).results)
        )
        .slice(0, MAX_BENCHMARK_HISTORY)
    : [];
  return {
    reportFolder:
      typeof data.reportFolder === "string" && data.reportFolder.trim().length > 0
        ? data.reportFolder
        : DEFAULT_BENCHMARK_SETTINGS.reportFolder,
    history,
  };
}

export function normalizeRagSettings(raw: unknown): RagSettings {
  const data = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<RagSettings>;
  return {
    enabled: typeof data.enabled === "boolean" ? data.enabled : DEFAULT_RAG_SETTINGS.enabled,
    activeEmbeddingModelId:
      typeof data.activeEmbeddingModelId === "string"
        ? data.activeEmbeddingModelId
        : DEFAULT_RAG_SETTINGS.activeEmbeddingModelId,
    chunkSize:
      typeof data.chunkSize === "number" ? data.chunkSize : DEFAULT_RAG_SETTINGS.chunkSize,
    chunkOverlap:
      typeof data.chunkOverlap === "number" ? data.chunkOverlap : DEFAULT_RAG_SETTINGS.chunkOverlap,
    topK: typeof data.topK === "number" ? data.topK : DEFAULT_RAG_SETTINGS.topK,
    maxChunksPerFile:
      typeof data.maxChunksPerFile === "number"
        ? data.maxChunksPerFile
        : DEFAULT_RAG_SETTINGS.maxChunksPerFile,
    minScore: typeof data.minScore === "number" ? data.minScore : DEFAULT_RAG_SETTINGS.minScore,
    excludePatterns: Array.isArray(data.excludePatterns)
      ? data.excludePatterns.filter((p): p is string => typeof p === "string")
      : [...DEFAULT_RAG_SETTINGS.excludePatterns],
    maxContextChars:
      typeof data.maxContextChars === "number"
        ? data.maxContextChars
        : DEFAULT_RAG_SETTINGS.maxContextChars,
    metadataEnrichment:
      typeof data.metadataEnrichment === "boolean"
        ? data.metadataEnrichment
        : DEFAULT_RAG_SETTINGS.metadataEnrichment,
  };
}

const VALID_GATES = new Set<Gate>(["auto", "ask", "deny"]);

/**
 * One class's gate, tolerant of both the three-way value and the short-lived
 * binary model. A valid gate string is taken as-is; a saved boolean from the
 * binary era migrates as `false` ⇒ `deny` (tool removed) and `true` ⇒ `ask`
 * (enabled + reviewed, the binary `true` never auto-applied), so no one's
 * "off" choice silently becomes "review".
 */
export function normalizeGate(raw: unknown, fallback: Gate): Gate {
  if (typeof raw === "string" && VALID_GATES.has(raw as Gate)) return raw as Gate;
  if (typeof raw === "boolean") return raw ? "ask" : "deny";
  return fallback;
}

export function normalizeVaultOpPolicy(raw: unknown): VaultOpPolicy {
  const data = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_VAULT_OP_POLICY;
  return {
    create: normalizeGate(data.create, d.create),
    overwrite: normalizeGate(data.overwrite, d.overwrite),
    move: normalizeGate(data.move, d.move),
    trash: normalizeGate(data.trash, d.trash),
    createDir: normalizeGate(data.createDir, d.createDir),
    edit: normalizeGate(data.edit, d.edit),
    scopes: Array.isArray(data.scopes)
      ? data.scopes.filter((s): s is string => typeof s === "string")
      : [...d.scopes],
    maxAutoOps:
      typeof data.maxAutoOps === "number" && data.maxAutoOps >= 0
        ? Math.floor(data.maxAutoOps)
        : d.maxAutoOps,
  };
}

/**
 * Derive the per-provider `enabled` toggle. A saved boolean wins; absent
 * (pre-Providers-tab data or first run) keyless providers default on and
 * api-key providers default to "on exactly when a key is stored". Either way
 * an api-key provider is clamped off without a key, so the enabled-but-broken
 * state is unrepresentable at the data layer, not just in the UI.
 */
function deriveEnabled(
  saved: unknown,
  provider: ProviderOption,
  hasKey: boolean,
  disclaimerAccepted: boolean,
): boolean {
  const descriptor = PROVIDER_DESCRIPTORS[provider];
  if (descriptor.authType === "api-key") {
    // Keyed clouds gate on the key itself, whose entry is disclaimer-gated in
    // the Providers tab. No key, never enabled; otherwise honor the saved flag
    // (or auto-enable a freshly upgraded blob that already carries a key).
    if (!hasKey) return false;
    return typeof saved === "boolean" ? saved : true;
  }
  if (descriptor.kind === "cloud") {
    // Keyless cloud (Claude Code) has no key to gate on, so it gates directly on
    // the one-time privacy acknowledgement. A stale enabled=true left by the old
    // ship-enabled default is forced off until the user opts in past the modal.
    if (!disclaimerAccepted) return false;
    return typeof saved === "boolean" ? saved : DEFAULT_SETTINGS.providerSettings[provider].enabled;
  }
  // Local provider (LM Studio) ships enabled.
  return typeof saved === "boolean" ? saved : true;
}

export function normalizeProviderSettingsMap(
  data: Partial<PluginSettings> | null,
): ProviderSettingsMap {
  const saved = data?.providerSettings;
  const defaults = DEFAULT_SETTINGS.providerSettings;
  const disclaimerAccepted = data?.apiKeysDisclaimerAccepted === true;
  const anthropicKey = typeof saved?.anthropic?.apiKey === "string"
    ? saved.anthropic.apiKey
    : defaults.anthropic.apiKey;
  const openaiKey = typeof saved?.openai?.apiKey === "string"
    ? saved.openai.apiKey
    : defaults.openai.apiKey;
  return {
    lmstudio: {
      enabled: deriveEnabled(saved?.lmstudio?.enabled, "lmstudio", true, disclaimerAccepted),
      baseUrl: saved?.lmstudio?.baseUrl ?? defaults.lmstudio.baseUrl,
      bypassCors: typeof saved?.lmstudio?.bypassCors === "boolean"
        ? saved.lmstudio.bypassCors
        : defaults.lmstudio.bypassCors,
    },
    anthropic: {
      enabled: deriveEnabled(
        saved?.anthropic?.enabled,
        "anthropic",
        anthropicKey.length > 0,
        disclaimerAccepted,
      ),
      apiKey: anthropicKey,
    },
    openai: {
      enabled: deriveEnabled(
        saved?.openai?.enabled,
        "openai",
        openaiKey.length > 0,
        disclaimerAccepted,
      ),
      apiKey: openaiKey,
      baseUrl: typeof saved?.openai?.baseUrl === "string"
        ? saved.openai.baseUrl
        : defaults.openai.baseUrl,
    },
    claudecode: {
      enabled: deriveEnabled(saved?.claudecode?.enabled, "claudecode", true, disclaimerAccepted),
      claudePath: typeof saved?.claudecode?.claudePath === "string"
        ? saved.claudecode.claudePath
        : defaults.claudecode.claudePath,
    },
  };
}

// Derived from the descriptor registry, so adding a provider (which already
// requires a PROVIDER_DESCRIPTORS entry) extends this automatically, no second
// hardcoded list to keep in sync.
const VALID_PROVIDERS = new Set<string>(Object.keys(PROVIDER_DESCRIPTORS));

export function normalizeProviderProfiles(raw: unknown): ProviderProfile[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (p): p is ProviderProfile =>
        typeof p === "object" &&
        p !== null &&
        typeof p.id === "string" &&
        typeof p.name === "string" &&
        VALID_PROVIDERS.has(p.provider) &&
        !p.isDefault,
    )
    .map((profile) => {
      // One-way migration: reasoning moved from the profile to the per-model
      // `reasoningByModelKey` map. Provider-wide values are deliberately not
      // carried over (capability sets vary per model; every model starts on its
      // true default), so the retired key is simply dropped on the next save.
      const cleaned = { ...profile } as ProviderProfile & { reasoning?: unknown };
      delete cleaned.reasoning;
      return cleaned;
    });
}

/**
 * Per-model reasoning entries: keys must be composed `provider:modelId` keys
 * and values known levels; anything else is dropped rather than carried
 * forever. Levels a model no longer offers are kept, the request-time clamp
 * (resolveModelReasoning) neutralizes them without rewriting user intent.
 */
export function normalizeReasoningByModelKey(raw: unknown): Record<string, ReasoningLevel> {
  if (typeof raw !== "object" || raw === null) return {};
  const result: Record<string, ReasoningLevel> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (parseModelKey(key) === null) continue;
    if (!isReasoningLevel(value)) continue;
    result[key] = value;
  }
  return result;
}

/**
 * Last-seen Claude Code handshake harvest: keys are normalized picker aliases
 * (plain non-empty strings), values arrays of known levels. An empty array is
 * kept, it means "model reports no effort support" and hides the pill; a
 * non-array or junk-only value drops the key so it degrades to the descriptor
 * fallback rather than persisting garbage.
 */
export function normalizeClaudeCodeEffortLevels(raw: unknown): Record<string, ReasoningLevel[]> {
  if (typeof raw !== "object" || raw === null) return {};
  const result: Record<string, ReasoningLevel[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.length === 0 || !Array.isArray(value)) continue;
    const levels = value.filter(isReasoningLevel);
    if (levels.length === 0 && value.length > 0) continue;
    result[key] = levels;
  }
  return result;
}

export function normalizeActiveProfileIds(raw: unknown): Record<ProviderOption, string> {
  const defaults = { ...DEFAULT_ACTIVE_PROFILE_IDS };
  if (typeof raw !== "object" || raw === null) return defaults;
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(defaults) as ProviderOption[]) {
    if (typeof obj[key] === "string") {
      defaults[key] = obj[key] as string;
    }
  }
  return defaults;
}

// ---------------------------------------------------------------------------
// Model identity migration (Providers-tab rework)
//
// The flat `completionModels` / `embeddingModels` profile arrays retired in
// favor of composed `provider:modelId` identity. Saved blobs that still carry
// them are read one last time here to seed the LM Studio last-seen cache and
// the cloud custom-model lists, to build the id alias map, and to rewrite
// stored pointers, then the arrays drop off disk on the next save.
// ---------------------------------------------------------------------------

interface LegacyModelRow {
  id: string;
  name: string;
  modelId: string;
  provider: ProviderOption;
}

function readLegacyModelRows(
  data: Partial<PluginSettings> | null,
  field: "completionModels" | "embeddingModels",
): LegacyModelRow[] {
  const raw = (data as Record<string, unknown> | null)?.[field];
  if (!Array.isArray(raw)) return [];
  const rows: LegacyModelRow[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.modelId !== "string" || row.modelId.length === 0) continue;
    if (typeof row.provider !== "string" || !VALID_PROVIDERS.has(row.provider)) continue;
    rows.push({
      id: typeof row.id === "string" ? row.id : "",
      name: typeof row.name === "string" && row.name.length > 0 ? row.name : row.modelId,
      modelId: row.modelId,
      provider: row.provider as ProviderOption,
    });
  }
  return rows;
}

/**
 * Cache rows are identity + display name only; capability fields are
 * deliberately stripped so a stale snapshot can never shadow live discovery
 * (the runtime falls back to the availability map when a row field is absent).
 */
function normalizeCacheRows<T extends CompletionModel | EmbeddingModel>(raw: unknown): T[] {
  if (!Array.isArray(raw)) return [];
  const rows: T[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.modelId !== "string" || row.modelId.length === 0) continue;
    const id = modelKey("lmstudio", row.modelId);
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({
      id,
      name: typeof row.name === "string" && row.name.length > 0 ? row.name : row.modelId,
      modelId: row.modelId,
      provider: "lmstudio",
    } as T);
  }
  return rows;
}

function normalizeLmStudioModelCache(
  data: Partial<PluginSettings> | null,
  legacyCompletion: LegacyModelRow[],
  legacyEmbedding: LegacyModelRow[],
): LmStudioModelCache {
  const raw = (data as Record<string, unknown> | null)?.lmStudioModelCache;
  if (typeof raw === "object" && raw !== null) {
    const cache = raw as Record<string, unknown>;
    return {
      completion: normalizeCacheRows<CompletionModel>(cache.completion),
      embedding: normalizeCacheRows<EmbeddingModel>(cache.embedding),
      discoveredAt: typeof cache.discoveredAt === "number" ? cache.discoveredAt : null,
    };
  }
  // First pass over pre-rework data: seed from the retired arrays so the
  // selector keeps rendering the user's models before the next discovery.
  return {
    completion: normalizeCacheRows<CompletionModel>(
      legacyCompletion.filter((row) => row.provider === "lmstudio"),
    ),
    embedding: normalizeCacheRows<EmbeddingModel>(
      legacyEmbedding.filter((row) => row.provider === "lmstudio"),
    ),
    discoveredAt: null,
  };
}

const VALID_MODEL_ROLES = new Set<ModelRole>(["completion", "embedding"]);

function normalizeCustomModels(
  data: Partial<PluginSettings> | null,
  legacyCompletion: LegacyModelRow[],
  legacyEmbedding: LegacyModelRow[],
): Partial<Record<ProviderOption, CustomModelEntry[]>> {
  const raw = (data as Record<string, unknown> | null)?.customModels;
  if (typeof raw === "object" && raw !== null) {
    const result: Partial<Record<ProviderOption, CustomModelEntry[]>> = {};
    for (const [provider, entries] of Object.entries(raw)) {
      if (!VALID_PROVIDERS.has(provider) || !Array.isArray(entries)) continue;
      const cleaned: CustomModelEntry[] = [];
      for (const entry of entries) {
        if (typeof entry !== "object" || entry === null) continue;
        const row = entry as Record<string, unknown>;
        if (typeof row.modelId !== "string" || row.modelId.length === 0) continue;
        if (typeof row.role !== "string" || !VALID_MODEL_ROLES.has(row.role as ModelRole)) continue;
        cleaned.push({
          modelId: row.modelId,
          name: typeof row.name === "string" && row.name.length > 0 ? row.name : row.modelId,
          role: row.role as ModelRole,
        });
      }
      if (cleaned.length > 0) result[provider as ProviderOption] = cleaned;
    }
    return result;
  }
  // First pass: cloud rows whose id the shipped catalog does not curate
  // survive as custom entries (fine-tunes, hand-entered ids).
  const result: Partial<Record<ProviderOption, CustomModelEntry[]>> = {};
  const seedFrom = (rows: LegacyModelRow[], role: ModelRole) => {
    for (const row of rows) {
      if (row.provider === "lmstudio") continue;
      const curated = getCatalogEntries(row.provider).some(
        (entry) => entry.modelId === row.modelId && entry.role === role,
      );
      if (curated) continue;
      const list = (result[row.provider] ??= []);
      if (list.some((entry) => entry.modelId === row.modelId && entry.role === role)) continue;
      list.push({ modelId: row.modelId, name: row.name, role });
    }
  };
  seedFrom(legacyCompletion, "completion");
  seedFrom(legacyEmbedding, "embedding");
  return result;
}

function normalizeModelIdAliases(
  data: Partial<PluginSettings> | null,
  legacyCompletion: LegacyModelRow[],
  legacyEmbedding: LegacyModelRow[],
): Record<string, string> {
  const aliases: Record<string, string> = {};
  const raw = (data as Record<string, unknown> | null)?.modelIdAliases;
  if (typeof raw === "object" && raw !== null) {
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "string" && value.length > 0) aliases[key] = value;
    }
  }
  for (const row of [...legacyCompletion, ...legacyEmbedding]) {
    if (row.id.length === 0 || aliases[row.id]) continue;
    aliases[row.id] = modelKey(row.provider, row.modelId);
  }
  return aliases;
}

/**
 * Build a fully-populated {@link PluginSettings} from whatever
 * `Plugin.loadData()` returned (a partial saved blob, or `null` on first run).
 * Every field defaults from {@link DEFAULT_SETTINGS}; collections are validated
 * element-by-element so a single bad entry can't poison the rest.
 */
/**
 * Migrates the prompt prefix. The plan/chat/edit mode prompts collapsed into one
 * unified prefix (prompt-cache design §6.3): a new `systemPromptPrefix` wins; otherwise
 * a customized legacy chat (then plan) prefix is carried forward, so a user's prior
 * wording survives. The edit-format prompts are dropped (their guidance is now dynamic).
 */
function migrateSystemPromptPrefix(data: Partial<PluginSettings> | null): string {
  if (typeof data?.systemPromptPrefix === "string") return data.systemPromptPrefix;
  const legacy = data as Record<string, unknown> | null;
  if (typeof legacy?.chatSystemPromptPrefix === "string") return legacy.chatSystemPromptPrefix;
  if (typeof legacy?.planSystemPromptPrefix === "string") return legacy.planSystemPromptPrefix;
  return DEFAULT_SETTINGS.systemPromptPrefix;
}

// The old per-mode round budgets (`maxToolRoundsEdit` / `maxToolRoundsChat`) collapsed
// into one `maxToolRounds` once the modes were gone; carry a customized legacy value
// forward, the live chat budget preferred over the dead edit one.
function migrateMaxToolRounds(data: Partial<PluginSettings> | null): number {
  if (typeof data?.maxToolRounds === "number") return data.maxToolRounds;
  const legacy = data as Record<string, unknown> | null;
  if (typeof legacy?.maxToolRoundsChat === "number") return legacy.maxToolRoundsChat;
  if (typeof legacy?.maxToolRoundsEdit === "number") return legacy.maxToolRoundsEdit;
  return DEFAULT_SETTINGS.maxToolRounds;
}

/**
 * Starred models are composed `provider:modelId` keys; anything else (wrong
 * type, malformed key, duplicate) is dropped rather than carried forever.
 */
function normalizeFavoriteModelKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const keys: string[] = [];
  for (const key of raw) {
    if (typeof key !== "string" || parseModelKey(key) === null) continue;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

export function normalizePluginSettings(data: Partial<PluginSettings> | null): PluginSettings {
  const legacyCompletion = readLegacyModelRows(data, "completionModels");
  const legacyEmbedding = readLegacyModelRows(data, "embeddingModels");

  const lmStudioModelCache = normalizeLmStudioModelCache(data, legacyCompletion, legacyEmbedding);
  const customModels = normalizeCustomModels(data, legacyCompletion, legacyEmbedding);
  const modelIdAliases = normalizeModelIdAliases(data, legacyCompletion, legacyEmbedding);

  /** Map a stored model pointer onto its composed key; non-legacy ids pass through. */
  const rekey = (id: string | null): string | null =>
    id !== null && modelIdAliases[id] ? modelIdAliases[id] : id;

  const commands: CustomCommand[] = Array.isArray(data?.commands)
    ? data.commands.map((command, index) => ({
        id: command?.id || `command-${index + 1}`,
        name: command?.name || `Command ${index + 1}`,
        prompt: command?.prompt ?? "",
        icon:
          typeof command?.icon === "string" && command.icon.trim().length > 0
            ? command.icon
            : "wand",
      }))
    : [];

  const chatHistory: ChatHistory =
    data?.chatHistory && typeof data.chatHistory === "object"
      ? normalizeChatHistory(data.chatHistory)
      : { ...DEFAULT_CHAT_HISTORY };
  for (const meta of chatHistory.conversations) {
    meta.modelId = rekey(meta.modelId) ?? meta.modelId;
  }

  const rag = normalizeRagSettings(data?.rag);
  rag.activeEmbeddingModelId = rekey(rag.activeEmbeddingModelId);

  const knowledgeGraph = normalizeKnowledgeGraphSettings(data?.knowledgeGraph);
  knowledgeGraph.activeCompletionModelId = rekey(knowledgeGraph.activeCompletionModelId);
  knowledgeGraph.activeEmbeddingModelId = rekey(knowledgeGraph.activeEmbeddingModelId);

  const providerSettings = normalizeProviderSettingsMap(data);

  return {
    providerSettings,
    includeNoteContext:
      typeof data?.includeNoteContext === "boolean"
        ? data.includeNoteContext
        : DEFAULT_SETTINGS.includeNoteContext,
    includeLocalAttachmentsAsContext:
      typeof data?.includeLocalAttachmentsAsContext === "boolean"
        ? data.includeLocalAttachmentsAsContext
        : DEFAULT_SETTINGS.includeLocalAttachmentsAsContext,
    maxContextChars:
      typeof data?.maxContextChars === "number"
        ? data.maxContextChars
        : DEFAULT_SETTINGS.maxContextChars,
    lmStudioModelCache,
    customModels,
    modelIdAliases,
    commands,
    chatHistory,
    providerProfiles: normalizeProviderProfiles(data?.providerProfiles),
    activeProfileIds: normalizeActiveProfileIds(data?.activeProfileIds),
    diffContextLines:
      typeof data?.diffContextLines === "number"
        ? data.diffContextLines
        : DEFAULT_SETTINGS.diffContextLines,
    diffMinMatchConfidence:
      typeof data?.diffMinMatchConfidence === "number"
        ? data.diffMinMatchConfidence
        : DEFAULT_SETTINGS.diffMinMatchConfidence,
    rag,
    knowledgeGraph,
    systemPromptPrefix: migrateSystemPromptPrefix(data),
    apiKeysDisclaimerAccepted:
      typeof data?.apiKeysDisclaimerAccepted === "boolean"
        ? data.apiKeysDisclaimerAccepted
        : DEFAULT_SETTINGS.apiKeysDisclaimerAccepted,
    agenticMode:
      typeof data?.agenticMode === "boolean"
        ? data.agenticMode
        : DEFAULT_SETTINGS.agenticMode,
    maxToolRounds: migrateMaxToolRounds(data),
    benchmark: normalizeBenchmarkSettings(data?.benchmark),
    vaultOpPolicy: normalizeVaultOpPolicy(data?.vaultOpPolicy),
    favoriteModelKeys: normalizeFavoriteModelKeys(data?.favoriteModelKeys),
    reasoningByModelKey: normalizeReasoningByModelKey(data?.reasoningByModelKey),
    claudeCodeEffortLevels: normalizeClaudeCodeEffortLevels(data?.claudeCodeEffortLevels),
  };
}

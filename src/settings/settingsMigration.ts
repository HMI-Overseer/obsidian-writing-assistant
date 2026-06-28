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
  EmbeddingModel,
  KnowledgeGraphSettings,
  PluginSettings,
  ProviderOption,
  ProviderProfile,
  ProviderSettingsMap,
  RagSettings,
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
import { PROVIDER_DESCRIPTORS } from "../providers/descriptors";
import { normalizeChatHistory } from "../chat/conversation/conversationUtils";
import { normalizeCompletionModel, normalizeEmbeddingModel } from "../shared/normalizeModels";

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

export function normalizeProviderSettingsMap(
  data: Partial<PluginSettings> | null,
): ProviderSettingsMap {
  const saved = data?.providerSettings;
  const defaults = DEFAULT_SETTINGS.providerSettings;
  return {
    lmstudio: {
      baseUrl: saved?.lmstudio?.baseUrl ?? defaults.lmstudio.baseUrl,
      bypassCors: typeof saved?.lmstudio?.bypassCors === "boolean"
        ? saved.lmstudio.bypassCors
        : defaults.lmstudio.bypassCors,
    },
    anthropic: {
      apiKey: typeof saved?.anthropic?.apiKey === "string"
        ? saved.anthropic.apiKey
        : defaults.anthropic.apiKey,
    },
    openai: {
      apiKey: typeof saved?.openai?.apiKey === "string"
        ? saved.openai.apiKey
        : defaults.openai.apiKey,
      baseUrl: typeof saved?.openai?.baseUrl === "string"
        ? saved.openai.baseUrl
        : defaults.openai.baseUrl,
    },
    claudecode: {
      claudePath: typeof saved?.claudecode?.claudePath === "string"
        ? saved.claudecode.claudePath
        : defaults.claudecode.claudePath,
    },
  };
}

// Derived from the descriptor registry, so adding a provider (which already
// requires a PROVIDER_DESCRIPTORS entry) extends this automatically — no second
// hardcoded list to keep in sync.
const VALID_PROVIDERS = new Set<string>(Object.keys(PROVIDER_DESCRIPTORS));

export function normalizeProviderProfiles(raw: unknown): ProviderProfile[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (p): p is ProviderProfile =>
      typeof p === "object" &&
      p !== null &&
      typeof p.id === "string" &&
      typeof p.name === "string" &&
      VALID_PROVIDERS.has(p.provider) &&
      !p.isDefault,
  );
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

export function normalizePluginSettings(data: Partial<PluginSettings> | null): PluginSettings {
  const completionModels: CompletionModel[] = Array.isArray(data?.completionModels)
    ? data.completionModels.map((model, index) => normalizeCompletionModel(model, index))
    : [];

  const embeddingModels: EmbeddingModel[] = Array.isArray(data?.embeddingModels)
    ? data.embeddingModels.map((model, index) => normalizeEmbeddingModel(model, index))
    : [];

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
    completionModels,
    embeddingModels,
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
    rag: normalizeRagSettings(data?.rag),
    knowledgeGraph: normalizeKnowledgeGraphSettings(data?.knowledgeGraph),
    systemPromptPrefix: migrateSystemPromptPrefix(data),
    apiKeysDisclaimerAccepted:
      typeof data?.apiKeysDisclaimerAccepted === "boolean"
        ? data.apiKeysDisclaimerAccepted
        : DEFAULT_SETTINGS.apiKeysDisclaimerAccepted,
    agenticMode:
      typeof data?.agenticMode === "boolean"
        ? data.agenticMode
        : DEFAULT_SETTINGS.agenticMode,
    preferToolUse:
      typeof data?.preferToolUse === "boolean"
        ? data.preferToolUse
        : DEFAULT_SETTINGS.preferToolUse,
    maxToolRoundsEdit:
      typeof data?.maxToolRoundsEdit === "number"
        ? data.maxToolRoundsEdit
        : DEFAULT_SETTINGS.maxToolRoundsEdit,
    maxToolRoundsChat:
      typeof data?.maxToolRoundsChat === "number"
        ? data.maxToolRoundsChat
        : DEFAULT_SETTINGS.maxToolRoundsChat,
    benchmark: normalizeBenchmarkSettings(data?.benchmark),
    vaultOpPolicy: normalizeVaultOpPolicy(data?.vaultOpPolicy),
  };
}

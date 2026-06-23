import type { MenuItem, WorkspaceLeaf } from "obsidian";
import { Notice, Plugin } from "obsidian";
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
} from "./shared/types";
import {
  DEFAULT_ACTIVE_PROFILE_IDS,
  DEFAULT_BENCHMARK_SETTINGS,
  DEFAULT_CHAT_HISTORY,
  DEFAULT_KNOWLEDGE_GRAPH_SETTINGS,
  DEFAULT_RAG_SETTINGS,
  DEFAULT_SETTINGS,
  MAX_BENCHMARK_HISTORY,
  VIEW_TYPE_CHAT,
} from "./constants";
import { DEFAULT_VAULT_OP_POLICY, type Gate, type VaultOpPolicy } from "./vault-ops/gateway";
import { ChatView } from "./chat";
import { BUILTIN_COMMAND_CATEGORIES, expandCommandTemplate } from "./commands";
import { getActiveNoteText } from "./context/noteContext";
import { InlineDiffManager } from "./editing/inlineDiff/InlineDiffManager";
import { inlineDiffExtension } from "./editing/inlineDiff/inlineDiffState";
import { normalizeChatHistory } from "./chat/conversation/conversationUtils";
import { normalizeCompletionModel, normalizeEmbeddingModel } from "./shared/normalizeModels";
import { WritingAssistantSettingTab } from "./settings/SettingsTab";
import { ServiceContainer } from "./services/ServiceContainer";

function normalizeKnowledgeGraphSettings(raw: unknown): KnowledgeGraphSettings {
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

function normalizeBenchmarkSettings(raw: unknown): BenchmarkSettings {
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

function normalizeRagSettings(raw: unknown): RagSettings {
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
function normalizeGate(raw: unknown, fallback: Gate): Gate {
  if (typeof raw === "string" && VALID_GATES.has(raw as Gate)) return raw as Gate;
  if (typeof raw === "boolean") return raw ? "ask" : "deny";
  return fallback;
}

function normalizeVaultOpPolicy(raw: unknown): VaultOpPolicy {
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

function normalizeProviderSettingsMap(
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

const VALID_PROVIDERS = new Set<string>(["lmstudio", "openai", "anthropic", "claudecode"]);

function normalizeProviderProfiles(raw: unknown): ProviderProfile[] {
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

function normalizeActiveProfileIds(raw: unknown): Record<ProviderOption, string> {
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

export default class WritingAssistantChat extends Plugin {
  settings!: PluginSettings;
  services!: ServiceContainer;
  inlineDiff!: InlineDiffManager;

  async onload(): Promise<void> {
    await this.loadSettings();
    const pluginDir =
      this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    this.services = new ServiceContainer(this.app, () => this.settings, pluginDir);
    await this.services.initialize();

    // In-note diff overlay: a CM6 extension renders pending edit proposals inline
    // in the active editor, sharing the same EditReviewController as the chat panel.
    this.inlineDiff = new InlineDiffManager(this.app);
    this.registerEditorExtension(inlineDiffExtension);
    for (const ref of this.inlineDiff.workspaceEvents()) this.registerEvent(ref);

    this.registerView(VIEW_TYPE_CHAT, (leaf: WorkspaceLeaf) => new ChatView(leaf, this));

    this.addRibbonIcon("message-square", "Writing assistant chat", () => {
      this.activateChatView();
    });

    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      callback: () => this.activateChatView(),
    });

    this.addCommand({
      id: "send-selection-to-chat",
      name: "Send selection to chat",
      editorCallback: (editor) => {
        const selection = editor.getSelection();
        if (!selection) {
          new Notice("No text selected.");
          return;
        }

        this.activateChatView().then(() => {
          setTimeout(() => {
            const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
            if (leaves.length > 0) {
              const view = leaves[0].view as ChatView;
              view.seedPrompt(selection);
            }
          }, 100);
        });
      },
    });

    this.addCommand({
      id: "edit-active-note",
      name: "Edit active note with AI",
      editorCallback: async () => {
        await this.activateChatView();
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
        if (leaves.length > 0) {
          const view = leaves[0].view as ChatView;
          view.setMode("edit");
        }
      },
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        const selection = editor.getSelection();
        if (!selection) return;

        menu.addItem((item) => {
          item.setTitle("Writing assistant").setIcon("message-square");
          const submenu = (item as MenuItem & { setSubmenu: () => typeof menu }).setSubmenu();

          const addCommandItem = (command: CustomCommand) => {
            submenu.addItem((sub) => {
              sub.setTitle(command.name).setIcon(command.icon ?? "wand").onClick(async () => {
                // Keep the note's tail: {{note}} feeds continuation commands
                // ("Continue writing from where the note leaves off"), so when a
                // long chapter exceeds the budget the model must see the ending,
                // not the opening.
                const noteText =
                  (await getActiveNoteText(this.app, this.settings.maxContextChars, "tail")) ?? "";
                const expanded = expandCommandTemplate(command.prompt, { selection, noteText });

                await this.activateChatView();
                setTimeout(async () => {
                  const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
                  if (leaves.length > 0) {
                    await (leaves[0].view as ChatView).sendCommand(expanded);
                  }
                }, 100);
              });
            });
          };

          for (let i = 0; i < BUILTIN_COMMAND_CATEGORIES.length; i++) {
            if (i > 0) submenu.addSeparator();
            for (const command of BUILTIN_COMMAND_CATEGORIES[i].commands) {
              addCommandItem(command);
            }
          }

          const userCommands = this.settings.commands;
          if (userCommands.length > 0) {
            submenu.addSeparator();
            for (const command of userCommands) {
              addCommandItem(command);
            }
          }
        });
      })
    );

    this.addSettingTab(new WritingAssistantSettingTab(this.app, this));

    if (this.app.workspace.layoutReady) {
      this.initLeafIfNeeded();
    } else {
      this.app.workspace.onLayoutReady(() => this.initLeafIfNeeded());
    }
  }

  onunload(): void {
    this.inlineDiff.destroy();
    this.services.destroy();
    // Obsidian handles view cleanup automatically on plugin unload.
    // Detaching leaves here would reset their position on reload.
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<PluginSettings> | null;

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

    this.settings = {
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
      planSystemPromptPrefix:
        typeof data?.planSystemPromptPrefix === "string"
          ? data.planSystemPromptPrefix
          : DEFAULT_SETTINGS.planSystemPromptPrefix,
      chatSystemPromptPrefix:
        typeof data?.chatSystemPromptPrefix === "string"
          ? data.chatSystemPromptPrefix
          : DEFAULT_SETTINGS.chatSystemPromptPrefix,
      editToolSystemPromptPrefix:
        typeof data?.editToolSystemPromptPrefix === "string"
          ? data.editToolSystemPromptPrefix
          : DEFAULT_SETTINGS.editToolSystemPromptPrefix,
      editFallbackSystemPromptPrefix:
        typeof data?.editFallbackSystemPromptPrefix === "string"
          ? data.editFallbackSystemPromptPrefix
          : DEFAULT_SETTINGS.editFallbackSystemPromptPrefix,
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

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private initLeafIfNeeded(): void {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
    if (existing.length === 0) return;
    this.app.workspace.revealLeaf(existing[0]);
  }

  async activateChatView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
}

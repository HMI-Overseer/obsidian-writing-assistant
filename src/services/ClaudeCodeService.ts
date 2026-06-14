import type { App } from "obsidian";
import { FileSystemAdapter } from "obsidian";
import { execFile } from "child_process";
import type { PluginSettings, ProviderOption } from "../shared/types";
import type { ClaudeCodeRuntime, SdkSessionTurnInput } from "../api/ClaudeCodeClient";
import { resolveClaudeBinary } from "../api/claudeCodeProcess";
import { isSdkAvailable } from "../api/sdk/claudeAgentSdk";
import type { Options } from "../api/sdk/claudeAgentSdk";
import { createVaultSdkMcpServer } from "../api/sdk/sdkMcpServer";
import { buildSdkOptions } from "../api/sdk/sdkQueryEngine";
import { SdkSessionRegistry } from "../api/sdk/sdkSession";
import type { SessionConfig } from "../api/harnessSession";
import { isCliVersionCompatible } from "../api/sdkVersionGuard";
import type { RagService } from "../rag/ragService";
import type { CanonicalToolDefinition, ToolCall, ToolResult } from "../tools/types";
import { ALL_VAULT_TOOLS, VAULT_TOOL_NAMES } from "../tools/vault/definition";
import { executeVaultTool } from "../tools/vault/handlers";
import { ALL_EDIT_TOOLS, EDIT_TOOL_NAMES } from "../tools/editing/definition";
import { executeEditTool } from "../tools/editing/handlers";
import { allowedVaultOpsTools, VAULT_OPS_TOOL_NAMES } from "../tools/vault-ops/definition";
import { executeVaultOpTool, buildPendingOverlay } from "../tools/vault-ops/handlers";
import { VaultMcpServer, type McpServerHandle, type McpToolProvider } from "../mcp/VaultMcpServer";
import { generateId } from "../utils";

/** Result of probing the local `claude` binary for the settings panel. */
export interface ClaudeCodeDetection {
  installed: boolean;
  /** Version string from `claude --version`, when detected. */
  version?: string;
  /** Whether the bundled Agent SDK linked correctly at runtime. */
  sdkAvailable: boolean;
  /**
   * Whether the installed CLI's version is compatible with the bundled SDK.
   * The SDK-backed session path gates on this; when false it falls back to the
   * legacy one-shot CLI path. False when the CLI is missing or unparseable.
   */
  sdkCompatible: boolean;
}

/**
 * Tool-lifecycle event emitted as Claude Code calls the plugin's MCP tools during
 * a run. Claude Code's agent loop is internal to the subprocess, so these events
 * are the only window into its tool activity — the chat UI uses them to drive the
 * same agentic timeline the API providers populate through their own tool loop.
 */
export type ClaudeCodeToolEvent =
  | { phase: "start"; toolName: string }
  | { phase: "end"; toolName: string; args: Record<string, unknown>; isError: boolean };

/** Options for a single Claude Code run, set just before the subprocess is spawned. */
export interface ClaudeCodeRunOptions {
  /** Edit mode — exposes the plugin's edit tools and collects proposed edits for the diff panel. */
  editMode?: boolean;
  /** Vault-relative path of the active note (edit target + search relevance). */
  activeFilePath?: string;
  /**
   * Conversation id — keys the persistent SDK session (Model B). When present and
   * the SDK path is usable, turns reuse one live `claude` process per conversation
   * for context retention + incremental caching. Absent ⇒ stateless one-shot.
   */
  conversationId?: string;
}

/** Official Claude Code install / setup documentation. */
export const CLAUDE_CODE_SETUP_URL = "https://docs.claude.com/en/docs/claude-code/setup";

/** MCP server key — becomes the `mcp__writing_assistant__*` tool prefix. */
const MCP_SERVER_NAME = "writing_assistant";

/**
 * Owns Claude Code runtime concerns: the vault root used as the subprocess
 * working directory, probing the binary for the settings UI, and the MCP server
 * that exposes the plugin's toolstack to Claude Code. On the SDK path that server
 * is an in-process {@link createVaultSdkMcpServer} instance; on the legacy
 * fallback path (incompatible CLI) it is the loopback-HTTP {@link VaultMcpServer}.
 *
 * Edit handling: Claude Code runs its own agent loop, so its edit-tool calls
 * arrive at the MCP server during the run rather than through the plugin's tool
 * loop. We collect them here and hand them to the edit finalizer afterwards, so
 * proposals surface in the same diff-review panel the API providers use. The chat
 * UI serializes generation (one run at a time), so a single collection slot is
 * sufficient.
 */
export class ClaudeCodeService {
  private mcpServer: VaultMcpServer | null = null;
  /** Per-conversation registry of live SDK sessions (Model B). Disposed on unload. */
  private readonly sessionRegistry = new SdkSessionRegistry();
  /** Memoized SDK usability (SDK linked + CLI version-compatible). Probed once. */
  private sdkUsable: Promise<boolean> | null = null;
  private collectingEdits = false;
  private collectedEdits: ToolCall[] = [];
  /** Vault-op calls Claude Code made this run, surfaced to the same review panel. */
  private collectedVaultOps: ToolCall[] = [];
  private editTargetPath = "";
  /** Per-run sink for tool-lifecycle events. The chat UI serializes generation
   *  (one run at a time), so a single listener slot is sufficient. */
  private toolListener: ((event: ClaudeCodeToolEvent) => void) | null = null;

  constructor(
    private readonly app: App,
    private readonly getSettings: () => PluginSettings,
    private readonly getRagService: () => RagService,
  ) {}

  /** Resolved `claude` executable (configured path, or auto-detected). */
  private get command(): string {
    return resolveClaudeBinary(this.getSettings().providerSettings.claudecode.claudePath);
  }

  /** Absolute vault path, or undefined on non-filesystem (e.g. mobile) vaults. */
  private get vaultRoot(): string | undefined {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : undefined;
  }

  /**
   * Runtime context for a chat request. Returns undefined for non-Claude-Code
   * providers so the MCP server only starts when actually needed. Starting the
   * server before the subprocess is spawned is required — Claude Code connects to
   * it (and fetches its tool list) on launch, so edit-mode state must be set here.
   */
  async getRuntime(
    provider: ProviderOption,
    options: ClaudeCodeRunOptions = {},
  ): Promise<ClaudeCodeRuntime | undefined> {
    if (provider !== "claudecode") return undefined;

    const settings = this.getSettings();
    this.collectedEdits = [];
    this.collectedVaultOps = [];
    const useSdk = await this.isSdkUsable();
    const agentic = settings.agenticMode;

    // Structured edit tools follow the same gate as the API providers: edit mode +
    // preferToolUse, and only meaningful in agentic mode (analyst runs tool-less).
    this.collectingEdits = agentic && (options.editMode ?? false) && settings.preferToolUse;
    this.editTargetPath = options.activeFilePath ?? "";

    // SDK path with a conversation id → persistent per-conversation session
    // (Model B): one live `claude` process reused across turns for context
    // retention + incremental caching. The session bakes the current agentic/edit
    // config; config drift cold-rebuilds it (see harnessSession.isSessionUsable).
    if (useSdk && options.conversationId) {
      const conversationId = options.conversationId;
      return {
        vaultRoot: this.vaultRoot,
        useSdk,
        sdkSession: {
          conversationId,
          run: (input) => this.runSessionTurn(conversationId, input, agentic),
        },
      };
    }

    // SDK path without a conversation id (e.g. complete()) → stateless one-shot
    // with an in-process MCP server, rebuilt per turn so the advertised tool set
    // reflects the current edit-mode gate.
    if (useSdk) {
      return {
        vaultRoot: this.vaultRoot,
        useSdk,
        ...(agentic
          ? {
              sdkMcp: {
                server: createVaultSdkMcpServer(MCP_SERVER_NAME, this.createToolProvider()),
                serverName: MCP_SERVER_NAME,
              },
            }
          : {}),
      };
    }

    // Agentic mode off on the legacy path → pure analyst with no tools.
    if (!agentic) return { vaultRoot: this.vaultRoot, useSdk };

    // Fallback path (incompatible/missing CLI): the legacy loopback-HTTP bridge.
    const handle = await this.ensureMcpServer();
    return {
      vaultRoot: this.vaultRoot,
      useSdk,
      mcp: {
        configJson: buildMcpConfigJson(MCP_SERVER_NAME, handle),
        allowedTools: `mcp__${MCP_SERVER_NAME}`,
      },
    };
  }

  /**
   * Runs one turn through the conversation's persistent SDK session, minting it on
   * first use (or after invalidation) and reusing it otherwise. Builds the session
   * config the reuse predicate gates on, plus the option factory that bakes the
   * in-process MCP server when a fresh session is needed.
   */
  private runSessionTurn(
    conversationId: string,
    input: SdkSessionTurnInput,
    agentic: boolean,
  ): AsyncGenerator<string> {
    const toolNames = agentic
      ? this.createToolProvider().listTools().map((definition) => definition.name)
      : [];
    const cfg: SessionConfig = {
      model: input.model,
      systemPrompt: input.systemPrompt,
      reasoning: input.reasoning ?? "off",
      editMode: this.collectingEdits,
      agenticMode: agentic,
      toolNames,
    };

    const command = this.command;
    const vaultRoot = this.vaultRoot;
    const buildOptions = (abortController: AbortController): Options => {
      const sdkMcp = agentic
        ? {
            server: createVaultSdkMcpServer(MCP_SERVER_NAME, this.createToolProvider()),
            serverName: MCP_SERVER_NAME,
          }
        : undefined;
      return buildSdkOptions(
        {
          model: input.model,
          systemPrompt: input.systemPrompt,
          reasoning: input.reasoning,
          claudePath: command,
          vaultRoot,
          sdkMcp,
        },
        abortController,
      );
    };

    return this.sessionRegistry.runTurn(conversationId, {
      cfg,
      turns: input.turns,
      fullPrompt: input.fullPrompt,
      deltaPrompt: input.deltaPrompt,
      buildOptions,
      signal: input.signal,
      onResult: input.onResult,
    });
  }

  /**
   * Whether to drive Claude Code through the Agent SDK: the SDK must have linked
   * at runtime and the installed CLI must be version-compatible with it. Probed
   * once (the `--version` exec is memoized) and reused for the session — the
   * settings UI's {@link detect} runs the same check independently.
   */
  private isSdkUsable(): Promise<boolean> {
    if (!this.sdkUsable) {
      this.sdkUsable = this.detect().then((d) => d.sdkAvailable && d.sdkCompatible);
    }
    return this.sdkUsable;
  }

  /**
   * Registers (or clears, with null) the sink that receives tool-lifecycle events
   * for the current run. Set just before generation starts and cleared in its
   * `finally` so events never leak across runs.
   */
  setToolListener(listener: ((event: ClaudeCodeToolEvent) => void) | null): void {
    this.toolListener = listener;
  }

  /** Returns and clears the edit-tool calls Claude Code made during the last run. */
  takeCollectedEdits(): ToolCall[] {
    const edits = this.collectedEdits;
    this.collectedEdits = [];
    return edits;
  }

  /** Returns and clears the vault-op calls Claude Code made during the last run. */
  takeCollectedVaultOps(): ToolCall[] {
    const ops = this.collectedVaultOps;
    this.collectedVaultOps = [];
    return ops;
  }

  /** Probes `claude --version` to report install status for the settings panel. */
  detect(): Promise<ClaudeCodeDetection> {
    const sdkAvailable = isSdkAvailable();
    return new Promise((resolve) => {
      execFile(this.command, ["--version"], { windowsHide: true }, (error, stdout) => {
        if (error) {
          resolve({ installed: false, sdkAvailable, sdkCompatible: false });
          return;
        }
        const version = stdout.toString().trim() || undefined;
        resolve({
          installed: true,
          version,
          sdkAvailable,
          sdkCompatible: sdkAvailable && isCliVersionCompatible(version),
        });
      });
    });
  }

  private async ensureMcpServer(): Promise<McpServerHandle> {
    if (!this.mcpServer) {
      this.mcpServer = new VaultMcpServer(MCP_SERVER_NAME, this.createToolProvider());
    }
    return this.mcpServer.start();
  }

  /**
   * Bridges the plugin's tools to MCP. The same executors back the API providers'
   * tool loop, so Claude Code runs the identical, plugin-owned implementations.
   * Edit tools are advertised only in edit mode; their calls are collected for the
   * diff-review panel rather than applied directly.
   */
  private createToolProvider(): McpToolProvider {
    return {
      // When collecting writes, advertise the full write surface alongside reads:
      // the edit channel plus the vault-op tools the policy leaves usable (deny
      // detaches a class, spec §5, §9). Same catalogue the API providers receive.
      listTools: (): CanonicalToolDefinition[] =>
        this.collectingEdits
          ? [
              ...ALL_VAULT_TOOLS,
              ...ALL_EDIT_TOOLS,
              ...allowedVaultOpsTools(this.getSettings().vaultOpPolicy),
            ]
          : ALL_VAULT_TOOLS,
      callTool: async (call: ToolCall): Promise<ToolResult> => {
        // Surface tool activity to the chat UI's timeline (Claude Code runs its
        // loop internally, so this MCP hook is the only place we see its calls).
        // The `end` event fires in finally so a thrown tool never leaves a stuck
        // pending placeholder in the timeline.
        this.toolListener?.({ phase: "start", toolName: call.name });
        let isError = true;
        try {
          const result = await this.executeTool(call);
          isError = result.isError ?? false;
          return result;
        } finally {
          this.toolListener?.({ phase: "end", toolName: call.name, args: call.arguments, isError });
        }
      },
    };
  }

  /** Routes one MCP tool call to the matching plugin executor (vault or edit). */
  private async executeTool(call: ToolCall): Promise<ToolResult> {
    if (VAULT_TOOL_NAMES.has(call.name)) {
      return executeVaultTool(call, {
        app: this.app,
        ragService: this.getRagService(),
        activeFilePath: this.app.workspace.getActiveFile()?.path,
      });
    }
    if (EDIT_TOOL_NAMES.has(call.name)) {
      if (!this.collectingEdits) {
        return { content: `Editing is not available in this mode: ${call.name}`, isReadOnly: false, isError: true };
      }
      // Validate + acknowledge now (so Claude Code can self-correct), and stash
      // the call so the diff panel can render it after the run.
      const result = await executeEditTool(call, { app: this.app, filePath: this.editTargetPath });
      if (!result.isError) {
        this.collectedEdits.push({ id: generateId(), name: call.name, arguments: call.arguments });
      }
      return result;
    }
    if (VAULT_OPS_TOOL_NAMES.has(call.name)) {
      if (!this.collectingEdits) {
        return { content: `Vault operations are not available in this mode: ${call.name}`, isReadOnly: false, isError: true };
      }
      // Validate against disk overlaid with this run's prior vault ops (spec §4),
      // so a later move_file sees an earlier write_file. Nothing touches disk here
      // — the collected calls build the review panel's proposal after the run.
      const overlay = buildPendingOverlay(this.app, this.collectedVaultOps);
      const result = executeVaultOpTool(call, { app: this.app, overlay });
      if (!result.isError) {
        this.collectedVaultOps.push({ id: generateId(), name: call.name, arguments: call.arguments });
      }
      return result;
    }
    return { content: `Unknown tool: ${call.name}`, isReadOnly: true, isError: true };
  }

  destroy(): void {
    // Kill every live SDK process — the §1 "don't leak processes" rule.
    this.sessionRegistry.disposeAll();
    this.mcpServer?.stop();
    this.mcpServer = null;
  }
}

/** Builds the `--mcp-config` JSON describing the loopback HTTP MCP server. */
function buildMcpConfigJson(serverName: string, handle: McpServerHandle): string {
  return JSON.stringify({
    mcpServers: {
      [serverName]: {
        type: "http",
        url: handle.url,
        headers: { Authorization: `Bearer ${handle.token}` },
      },
    },
  });
}

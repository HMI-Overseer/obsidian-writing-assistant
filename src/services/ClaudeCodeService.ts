import type { App } from "obsidian";
import { FileSystemAdapter } from "obsidian";
import { execFile } from "child_process";
import type { PluginSettings, ProviderOption } from "../shared/types";
import type { ClaudeCodeRuntime } from "../api/ClaudeCodeClient";
import { resolveClaudeBinary } from "../api/claudeCodeProcess";
import type { RagService } from "../rag/ragService";
import type { CanonicalToolDefinition, ToolCall, ToolResult } from "../tools/types";
import { ALL_VAULT_TOOLS, VAULT_TOOL_NAMES } from "../tools/vault/definition";
import { executeVaultTool } from "../tools/vault/handlers";
import { ALL_EDIT_TOOLS, EDIT_TOOL_NAMES } from "../tools/editing/definition";
import { executeEditTool } from "../tools/editing/handlers";
import { VaultMcpServer, type McpServerHandle, type McpToolProvider } from "../mcp/VaultMcpServer";
import { generateId } from "../utils";

/** Result of probing the local `claude` binary for the settings panel. */
export interface ClaudeCodeDetection {
  installed: boolean;
  /** Version string from `claude --version`, when detected. */
  version?: string;
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
}

/** Official Claude Code install / setup documentation. */
export const CLAUDE_CODE_SETUP_URL = "https://docs.claude.com/en/docs/claude-code/setup";

/** MCP server key — becomes the `mcp__writing_assistant__*` tool prefix. */
const MCP_SERVER_NAME = "writing_assistant";

/**
 * Owns Claude Code runtime concerns: the vault root used as the subprocess
 * working directory, probing the binary for the settings UI, and the in-process
 * MCP server that exposes the plugin's toolstack to the `claude` subprocess.
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
  private collectingEdits = false;
  private collectedEdits: ToolCall[] = [];
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

    // Agentic mode off → run Claude Code as a pure analyst with no tools, matching
    // the agentic toggle's "no tools used" semantics. The vault grounding (and any
    // edits) require the MCP bridge, which only loads when agentic mode is on.
    if (!settings.agenticMode) {
      this.collectingEdits = false;
      return { vaultRoot: this.vaultRoot };
    }

    // Structured edit tools follow the same gate as the API providers: edit mode +
    // preferToolUse. Otherwise only the read tools are exposed.
    this.collectingEdits = (options.editMode ?? false) && settings.preferToolUse;
    this.editTargetPath = options.activeFilePath ?? "";

    const handle = await this.ensureMcpServer();
    return {
      vaultRoot: this.vaultRoot,
      mcp: {
        configJson: buildMcpConfigJson(MCP_SERVER_NAME, handle),
        allowedTools: `mcp__${MCP_SERVER_NAME}`,
      },
    };
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

  /** Probes `claude --version` to report install status for the settings panel. */
  detect(): Promise<ClaudeCodeDetection> {
    return new Promise((resolve) => {
      execFile(this.command, ["--version"], { windowsHide: true }, (error, stdout) => {
        if (error) {
          resolve({ installed: false });
          return;
        }
        resolve({ installed: true, version: stdout.toString().trim() || undefined });
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
      listTools: (): CanonicalToolDefinition[] =>
        this.collectingEdits ? [...ALL_VAULT_TOOLS, ...ALL_EDIT_TOOLS] : ALL_VAULT_TOOLS,
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
    return { content: `Unknown tool: ${call.name}`, isReadOnly: true, isError: true };
  }

  destroy(): void {
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

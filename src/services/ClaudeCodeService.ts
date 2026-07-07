import type { App } from "obsidian";
import { FileSystemAdapter } from "obsidian";
import { execFile } from "child_process";
import type {
  ApprovalPosture,
  PluginSettings,
  ProviderOption,
  ReasoningLevel,
} from "../shared/types";
import type { ClaudeCodeRuntime, SdkSessionTurnInput } from "../api/ClaudeCodeClient";
import { resolveClaudeBinary } from "../api/claudeCodeProcess";
import { isSdkAvailable } from "../api/sdk/claudeAgentSdk";
import type { Options } from "../api/sdk/claudeAgentSdk";
import { createVaultSdkMcpServer } from "../api/sdk/sdkMcpServer";
import { buildSdkOptions } from "../api/sdk/sdkQueryEngine";
import { harvestEffortLevels } from "../api/sdk/effortHarvest";
import { SdkSessionRegistry } from "../api/sdk/sdkSession";
import type { SessionConfig } from "../api/harnessSession";
import { isCliVersionCompatible } from "../api/sdkVersionGuard";
import type { RagService } from "../rag/ragService";
import type { CanonicalToolDefinition, ToolCall, ToolResult } from "../tools/types";
import type { VaultOpDisposition } from "../vault-ops/disposition";
import { VAULT_TOOL_NAMES } from "../tools/vault/definition";
import { executeVaultTool } from "../tools/vault/handlers";
import { toolFailure } from "../tools/toolFailure";
import { EDIT_TOOL_NAMES } from "../tools/editing/definition";
import { executeEditTool } from "../tools/editing/handlers";
import { VAULT_OPS_TOOL_NAMES } from "../tools/vault-ops/definition";
import { executeVaultOpTool, buildPendingOverlay } from "../tools/vault-ops/handlers";
import {
  CLAUDE_CODE_STABLE_TOOL_SET,
  cloudAllowedToolSet,
  toolNotAllowedFailure,
} from "../tools/toolSurface";
import { normalizeVaultToolCall } from "../tools/paths";
import { VaultMcpServer, type McpServerHandle, type McpToolProvider } from "../mcp/VaultMcpServer";
import type { VaultOpReviewer } from "../tools/types";
import { generateId } from "../utils";

/** Result of probing the local `claude` binary for the settings panel. */
export interface ClaudeCodeDetection {
  installed: boolean;
  /** Version string from `claude --version`, when detected. */
  version?: string;
  /** Whether the bundled Agent SDK linked correctly at runtime. */
  sdkAvailable: boolean;
  /**
   * Whether the installed CLI version is compatible with the bundled SDK. Gates the
   * SDK session path; false (also when the CLI is missing or unparseable) falls back
   * to the legacy one-shot path.
   */
  sdkCompatible: boolean;
}

/**
 * Tool-lifecycle event emitted as Claude Code calls the plugin's MCP tools during
 * a run. Claude Code's agent loop is internal to the subprocess, so these events
 * are the only window into its tool activity, the chat UI uses them to drive the
 * same agentic timeline the API providers populate through their own tool loop.
 */
export type ClaudeCodeToolEvent =
  | { phase: "start"; toolName: string; toolCallId: string }
  | {
      phase: "end";
      toolName: string;
      args: Record<string, unknown>;
      isError: boolean;
      /**
       * The tool result text returned to Claude Code. Surfaced on the timeline step's
       * error block when `isError`, so a failed call (e.g. an edit's no-match) shows
       * what the model saw, Claude Code's loop is otherwise opaque to the UI. Also the
       * source the step's replay digest + bounded record are computed from (phase 2).
       */
      content: string;
      toolCallId: string;
      /**
       * The reviewed op's real disposition, when this call went through the live
       * review, so the step persists the outcome for the cold-rebuild replay digest
       * (a decline resolves `isError: false`; §6 question 6). Absent on read tools.
       */
      disposition?: VaultOpDisposition;
    };

/** Options for a single Claude Code run, set just before the subprocess is spawned. */
export interface ClaudeCodeRunOptions {
  /** Session approval posture; gates which writes the per-run allow-list permits (§6.3). */
  posture?: ApprovalPosture;
  /** Vault-relative path of the active note (edit target + search relevance). */
  activeFilePath?: string;
  /**
   * Conversation id, keys the persistent SDK session (Model B). When present and
   * the SDK path is usable, turns reuse one live `claude` process per conversation
   * for context retention + incremental caching. Absent ⇒ stateless one-shot.
   */
  conversationId?: string;
}

/** Official Claude Code install / setup documentation. */
export const CLAUDE_CODE_SETUP_URL = "https://docs.claude.com/en/docs/claude-code/setup";

/** MCP server key, becomes the `mcp__writing_assistant__*` tool prefix. */
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
  /**
   * Per-run tool allow-list (prompt-cache design §6.1.4). The MCP server advertises
   * the full stable superset always (so `toolNames` never drifts and the live session
   * survives mode switches); this names what the *current* run actually permits, and
   * {@link executeTool} refuses anything outside it. Reads are always present; writes
   * follow the run's mode + policy. Set per turn in {@link getRuntime}; the chat UI
   * serializes generation, so one slot is sufficient.
   */
  private runAllowedTools: Set<string> = new Set();
  private collectedEdits: ToolCall[] = [];
  /** Vault-op calls Claude Code made this run, surfaced to the same review panel. */
  private collectedVaultOps: ToolCall[] = [];
  private editTargetPath = "";
  /** Per-run sink for tool-lifecycle events. The chat UI serializes generation
   *  (one run at a time), so a single listener slot is sufficient. */
  private toolListener: ((event: ClaudeCodeToolEvent) => void) | null = null;
  /** Per-run in-loop review coordinator. When set, vault-op calls suspend on the
   *  user's approve/decline and return the real disposition rather than collecting
   *  for a post-run panel (in-loop-tool-approval-blocking-flow). */
  private liveReview: VaultOpReviewer | null = null;

  constructor(
    private readonly app: App,
    private readonly getSettings: () => PluginSettings,
    private readonly getRagService: () => RagService,
    /**
     * Receives the normalized effort-level harvest whenever a fresh SDK session
     * mints (§3.1 layer 2). The container merges it into the availability
     * service and the persisted last-seen cache; absent in tests.
     */
    private readonly onEffortLevelsDiscovered?: (
      levels: Record<string, ReasoningLevel[]>,
    ) => void,
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
   * server before the subprocess is spawned is required, Claude Code connects to
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

    // Per-run allow-list, the same canonical resolver the API providers use: reads
    // unrestricted, writes follow the posture + policy. Held OFF the session
    // fingerprint (it is not baked into SessionConfig), so a posture flip reuses the
    // live session instead of cold-rebuilding (prompt-cache design §6.1.4/§6.3); the
    // gate in executeTool enforces it per turn. Empty when not agentic (no tools run).
    this.runAllowedTools = agentic
      ? new Set(
          cloudAllowedToolSet({
            posture: options.posture ?? "ask",
            policy: settings.vaultOpPolicy,
            useThinkTool: false,
          }).map((tool) => tool.name),
        )
      : new Set();
    this.editTargetPath = options.activeFilePath ?? "";

    // SDK path with a conversation id → persistent per-conversation session
    // (Model B): one live `claude` process reused across turns for context
    // retention + incremental caching. The session bakes model / systemPrompt /
    // agentic / toolNames; config drift cold-rebuilds it (see
    // harnessSession.isSessionUsable). Mode is no longer baked, so plan↔chat↔edit
    // switches reuse the session, the per-run allow-list gates writes instead.
    // Effort is compared outside the fingerprint: a low..xhigh change flips the
    // live session via applyFlagSettings instead of rebuilding (§3.2).
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
    // with an in-process MCP server. The advertised tool set is the constant stable
    // superset; the per-run allow-list gates what may actually run.
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
      effort: input.reasoning ?? null,
      turns: input.turns,
      fullPrompt: input.fullPrompt,
      deltaPrompt: input.deltaPrompt,
      buildOptions,
      signal: input.signal,
      onResult: input.onResult,
      onReuseDecision: input.onReuseDecision,
      ...(this.onEffortLevelsDiscovered
        ? {
            onModelsDiscovered: (models) =>
              this.onEffortLevelsDiscovered?.(harvestEffortLevels(models)),
          }
        : {}),
    });
  }

  /**
   * Whether to drive Claude Code through the Agent SDK: the SDK must have linked
   * at runtime and the installed CLI must be version-compatible with it. Probed
   * once (the `--version` exec is memoized) and reused for the session, the
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

  /**
   * Registers (or clears, with null) the in-loop vault-op review for the current
   * run. Set just before generation starts and cleared in its `finally` so a
   * coordinator never leaks across runs.
   */
  setLiveReview(review: VaultOpReviewer | null): void {
    this.liveReview = review;
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
   * tool loop, so Claude Code runs the identical, plugin-owned implementations. The
   * full superset (reads + edit + vault-ops) is advertised in every mode for session
   * stability; the per-run allow-list ({@link runAllowedTools}, enforced in
   * {@link executeTool}) decides what may actually run, and permitted edit/vault-op
   * calls are collected for the diff-review panel rather than applied directly.
   */
  private createToolProvider(): McpToolProvider {
    return {
      // Advertise the full stable superset (reads + edit + vault-ops) unchanged across
      // modes and RAG availability, so `toolNames` never drifts and the live session
      // survives a mode switch instead of cold-rebuilding (prompt-cache design §6.1.1).
      // semantic_search stays advertised and reports unavailability at call time (the
      // handler's curated message); the runtime allow-list (runAllowedTools, enforced
      // in executeTool) restricts writes per mode, not this catalogue.
      listTools: (): CanonicalToolDefinition[] => CLAUDE_CODE_STABLE_TOOL_SET,
      callTool: async (rawCall: ToolCall): Promise<ToolResult> => {
        // Surface tool activity to the chat UI's timeline (Claude Code runs its
        // loop internally, so this MCP hook is the only place we see its calls).
        // The `end` event fires in finally so a thrown tool never leaves a stuck
        // pending placeholder in the timeline.
        //
        // One id per call, minted here and threaded into both the timeline step
        // (via the events) and any collected vault op (via executeTool), so the
        // review binds its approve/decline to the *same* row rather than a
        // synthetic duplicate (vault-review-timeline-refinements).
        //
        // Translate absolute paths to vault-relative up front so the executor,
        // the collected op, and the timeline all see the same resolved path.
        const call = normalizeVaultToolCall(this.app, rawCall);
        const toolCallId = call.id || generateId();
        this.toolListener?.({ phase: "start", toolName: call.name, toolCallId });
        let isError = true;
        // The result text the model received, carried to the timeline so a failed
        // call shows its error. Defaults cover a thrown executor (no result object).
        let content = "The tool threw an unexpected error.";
        // The reviewed op's real disposition, when present, so the persisted step
        // records the outcome for the cold-rebuild replay digest (§6 question 6).
        let disposition: VaultOpDisposition | undefined;
        try {
          const result = await this.executeTool(call, toolCallId);
          isError = result.isError ?? false;
          content = result.content;
          disposition = result.disposition;
          return result;
        } finally {
          this.toolListener?.({
            phase: "end",
            toolName: call.name,
            args: call.arguments,
            isError,
            content,
            toolCallId,
            disposition,
          });
        }
      },
    };
  }

  /** Routes one MCP tool call to the matching plugin executor (vault or edit).
   *  `toolCallId` is the id minted in `callTool`; reused for the collected vault
   *  op so it shares the id of its timeline step (review binding). */
  private async executeTool(call: ToolCall, toolCallId: string): Promise<ToolResult> {
    // Runtime allow-list (prompt-cache design §6.1.4): the MCP server advertises the
    // full superset, so refuse a call the current run does not permit before it runs
    // or collects. Reads are always permitted; out-of-mode writes and policy-denied
    // ops (absent from the allow-list) are refused here, the primary deny gate, with
    // the live-review deny check as defense in depth.
    if (!this.runAllowedTools.has(call.name)) {
      return toolNotAllowedFailure(call.name);
    }
    if (VAULT_TOOL_NAMES.has(call.name)) {
      return executeVaultTool(call, {
        app: this.app,
        ragService: this.getRagService(),
        activeFilePath: this.app.workspace.getActiveFile()?.path,
      });
    }
    if (EDIT_TOOL_NAMES.has(call.name)) {
      // Live in-loop review: suspend on the edit until the user accepts/declines and
      // return the real disposition, mirroring vault ops (resolveEditOne). The diff
      // proposals are built in-loop, so finalization persists them via getEditProposals();
      // the collected call is only for the message's tool-call record.
      if (this.liveReview) {
        const result = await this.liveReview.resolveEditOne(call, toolCallId);
        if (!result.isError) {
          this.collectedEdits.push({ id: generateId(), name: call.name, arguments: call.arguments });
        }
        return result;
      }
      // Fallback (no live review wired): validate + acknowledge now (so Claude Code
      // can self-correct), and stash the call so the diff panel renders after the run.
      const result = await executeEditTool(call, { app: this.app, filePath: this.editTargetPath });
      if (!result.isError) {
        this.collectedEdits.push({ id: generateId(), name: call.name, arguments: call.arguments });
      }
      return result;
    }
    if (VAULT_OPS_TOOL_NAMES.has(call.name)) {
      // Live in-loop review: suspend on an `ask` op until the user approves or
      // declines, returning the real disposition as this call's result. The SDK
      // runs `permissionMode="dontAsk"`, so the plugin owns permission here.
      if (this.liveReview) {
        return this.liveReview.resolveOne(call, toolCallId);
      }
      // Fallback (no live review wired): validate against disk overlaid with this
      // run's prior vault ops so a later move_file sees an earlier write_file.
      // Nothing touches disk; the collected calls build a post-run review panel.
      const overlay = buildPendingOverlay(this.app, this.collectedVaultOps);
      const result = executeVaultOpTool(call, { app: this.app, overlay });
      if (!result.isError) {
        this.collectedVaultOps.push({ id: toolCallId, name: call.name, arguments: call.arguments });
      }
      return result;
    }
    return toolFailure({
      kind: "invalid-args",
      what: `unknown tool "${call.name}"`,
      recovery: "call one of the advertised tools instead",
    });
  }

  destroy(): void {
    // Kill every live SDK process, the "don't leak processes" rule.
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

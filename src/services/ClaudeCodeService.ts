import type { App } from "obsidian";
import { FileSystemAdapter } from "obsidian";
import { execFile } from "child_process";
import type {
  ApprovalPosture,
  ClaudeCodeResumeCursor,
  PluginSettings,
  ProviderOption,
  ReasoningLevel,
} from "../shared/types";
import type { ClaudeCodeRuntime, SdkSessionTurnInput } from "../api/ClaudeCodeClient";
import type { AssistantCaptureFrame } from "../api/assistantCapture";
import { resolveClaudeBinary } from "../api/claudeCodeProcess";
import { isSdkAvailable } from "../api/sdk/claudeAgentSdk";
import type { Options } from "../api/sdk/claudeAgentSdk";
import { createVaultSdkMcpServer } from "../api/sdk/sdkMcpServer";
import { buildSdkOptions } from "../api/sdk/sdkQueryEngine";
import type { ClaudeCodeProcessOwner } from "../api/sdk/claudeCodeSpawn";
import { harvestEffortLevels } from "../api/sdk/effortHarvest";
import { SdkSessionRegistry } from "../api/sdk/sdkSession";
import type { SessionConfig } from "../api/harnessSession";
import { isCliVersionCompatible } from "../api/sdkVersionGuard";
import type { RagService } from "../rag/ragService";
import type { MemoryService } from "../memory/MemoryService";
import { claudeCodeStableToolSet, cloudAllowedToolSet } from "../tools/toolSurface";
import { VaultMcpServer, type McpServerHandle } from "../mcp/VaultMcpServer";
import { generateId } from "../utils";
import {
  ClaudeCodeGenerationHandle,
  ClaudeCodeRunSlot,
  type ClaudeCodeRuntimeScope,
} from "./ClaudeCodeGenerationLease";
import {
  createClaudeCodeCallbackProvider,
  type ClaudeCodeCallbackDeps,
} from "./claudeCodeCallbackSurface";

export type { ClaudeCodeToolEvent } from "./ClaudeCodeGenerationLease";

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

/** Options for a single Claude Code run, set just before the subprocess is spawned. */
export interface ClaudeCodeRunOptions {
  /** Session approval posture; gates which writes the per-run allow-list permits (section 6.3). */
  posture?: ApprovalPosture;
  /** Vault-relative path of the active note (edit target + search relevance). */
  activeFilePath?: string;
  /**
   * Conversation id, keys the persistent SDK session. When present and the SDK path
   * is usable, turns reuse one live `claude` process per conversation for context
   * retention + incremental caching. Absent ⇒ stateless one-shot.
   */
  conversationId?: string;
  /**
   * The conversation's persisted resume cursor (Model A′), read from the last banked
   * turn. When the live process is gone, the registry re-checks it against this turn's
   * transcript and, if it passes, `resume`s the session from disk instead of
   * rebuilding. Absent ⇒ resume is not attempted.
   */
  resumeCursor?: ClaudeCodeResumeCursor;
  /**
   * The model's discovered context window, forwarded onto the runtime for the
   * send-path preflight (section 6.4, phase 5). Absent (first turn, none reported yet) ⇒
   * the preflight is a passive no-op.
   */
  contextWindow?: number;
}

/** Official Claude Code install / setup documentation. */
export const CLAUDE_CODE_SETUP_URL = "https://docs.claude.com/en/docs/claude-code/setup";

/** MCP server key, becomes the `mcp__writing_assistant__*` tool prefix. */
const MCP_SERVER_NAME = "writing_assistant";

/**
 * Owns Claude Code runtime concerns: the vault root used as the subprocess
 * working directory, probing the binary for the settings UI, and the MCP servers
 * that expose the plugin's toolstack to Claude Code. On the SDK path a server is an
 * in-process {@link createVaultSdkMcpServer} instance; on the legacy fallback path
 * (incompatible CLI) it is the loopback-HTTP {@link VaultMcpServer}.
 *
 * Callback ownership (RFC-0011 phase 5). The service holds no current-run state.
 * Each generation gets a {@link ClaudeCodeGenerationHandle} from {@link getRuntime},
 * and every callback surface the generation can reach owns a
 * {@link ClaudeCodeRunSlot} that the handle installs its lease into. A callback
 * therefore resolves to the generation that authorized it or to nothing, rather
 * than to whatever a mutable field happens to hold when it lands. Surfaces are per
 * provider session or per one-shot run (settled decision 17): the legacy loopback
 * server is no longer one shared service-wide provider for successive generations.
 */
export class ClaudeCodeService {
  /** Per-conversation registry of live SDK sessions (Model B). Disposed on unload. */
  private readonly sessionRegistry = new SdkSessionRegistry();
  /**
   * The callback slot of each conversation's live persistent session, so a new
   * generation can take over the surface its `claude` process already talks to. A
   * fresh mint replaces the entry and tombstones the one it displaces, which is
   * how a tombstone dies with the session it guards (settled decision 15.4).
   */
  private readonly sessionSlots = new Map<string, ClaudeCodeRunSlot>();
  /** Generations that have not released yet, so unload can retire their surfaces. */
  private readonly liveHandles = new Set<ClaudeCodeGenerationHandle>();
  /** Memoized SDK usability (SDK linked + CLI version-compatible). Probed once. */
  private sdkUsable: Promise<boolean> | null = null;

  constructor(
    private readonly app: App,
    private readonly getSettings: () => PluginSettings,
    private readonly getRagService: () => RagService,
    private readonly getMemoryService: () => MemoryService,
    private readonly persistSettings: () => Promise<void>,
    /**
     * Receives the normalized effort-level harvest whenever a fresh SDK session
     * mints (section 3.1 layer 2). The container merges it into the availability
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
   * it (and fetches its tool list) on launch.
   *
   * It mutates no service field. Everything this run needs, its allow-list, its
   * posture, its active note, its correlation posture, is sealed into one
   * {@link ClaudeCodeGenerationHandle} that the chat pipeline activates with the
   * generation's owners and releases in its `finally`.
   */
  async getRuntime(
    provider: ProviderOption,
    options: ClaudeCodeRunOptions = {},
  ): Promise<ClaudeCodeRuntime | undefined> {
    if (provider !== "claudecode") return undefined;

    const settings = this.getSettings();
    const useSdk = await this.isSdkUsable();
    const agentic = settings.agenticMode;
    // Forwarded onto every runtime shape below for the send-path preflight (section 6.4).
    const contextWindow = options.contextWindow ? { contextWindow: options.contextWindow } : {};

    // Per-run allow-list, the same canonical resolver the API providers use: reads
    // unrestricted, writes follow the posture + policy. Held OFF the session
    // fingerprint (it is not baked into SessionConfig), so a posture flip reuses the
    // live session instead of cold-rebuilding (prompt-cache design section 6.1.4/section 6.3); the
    // gate in the callback surface enforces it per turn. Empty when not agentic (no
    // tools run).
    const scope: ClaudeCodeRuntimeScope = {
      leaseId: `claude-generation-${generateId()}`,
      conversationId: options.conversationId ?? null,
      posture: options.posture ?? "ask",
      allowedTools: agentic
        ? new Set(
            cloudAllowedToolSet({
              posture: options.posture ?? "ask",
              policy: settings.vaultOpPolicy,
              useThinkTool: false,
              memoriesEnabled: settings.memoriesEnabled,
            }).map((tool) => tool.name),
          )
        : new Set<string>(),
      activeFilePath: options.activeFilePath ?? "",
      correlationPosture: useSdk ? "provider_id" : "none",
    };

    // The legacy path owns its loopback server for exactly one generation, so
    // teardown rides the handle rather than a service field.
    let legacyServer: VaultMcpServer | null = null;
    const handle = new ClaudeCodeGenerationHandle(scope, () => {
      legacyServer?.stop();
      this.liveHandles.delete(handle);
    });
    this.liveHandles.add(handle);
    const correlation = (): "provider_id" | "none" =>
      handle.activeLease?.toolCorrelation ?? scope.correlationPosture;

    // SDK path with a conversation id → persistent per-conversation session
    // (Model B): one live `claude` process reused across turns for context
    // retention + incremental caching. The session bakes model / systemPrompt /
    // agentic / toolNames; config drift cold-rebuilds it (see
    // harnessSession.isSessionUsable). Mode is no longer baked, so posture
    // switches reuse the session, the per-run allow-list gates writes instead.
    // Effort is compared outside the fingerprint: a low..xhigh change flips the
    // live session via applyFlagSettings instead of rebuilding (section 3.2).
    if (useSdk && options.conversationId) {
      const conversationId = options.conversationId;
      const resumeCursor = options.resumeCursor;
      if (agentic) this.adoptSessionSlot(conversationId, handle);
      return {
        vaultRoot: this.vaultRoot,
        useSdk,
        ...contextWindow,
        generation: handle,
        sdkSession: {
          conversationId,
          run: (input) =>
            this.runSessionTurn(conversationId, handle, input, agentic, resumeCursor),
          // The persistent path's hard dispose. The session owns the CLI child it
          // spawned, so this is the same 25 ms `kill()` the legacy path has always
          // had; it is reached only when the graceful tier overran its measured
          // deadline, or when capture failure means the session must not survive.
          // Its callback surface is tombstoned with it: a disposed session is never
          // reused, and neither is the slot it answered through (decisions 18, 15.4).
          hardDispose: () => {
            this.sessionSlots.get(conversationId)?.tombstone();
            this.sessionSlots.delete(conversationId);
            return this.sessionRegistry.disposeConversation(conversationId);
          },
        },
        getToolCorrelation: correlation,
      };
    }

    // SDK path without a conversation id (e.g. complete()) → stateless one-shot
    // with an in-process MCP server. The advertised tool set is the constant stable
    // superset; the per-run allow-list gates what may actually run.
    if (useSdk) {
      return {
        vaultRoot: this.vaultRoot,
        useSdk,
        ...contextWindow,
        generation: handle,
        ...(agentic
          ? {
              sdkMcp: {
                server: createVaultSdkMcpServer(
                  MCP_SERVER_NAME,
                  this.createCallbackProvider(handle),
                ),
                serverName: MCP_SERVER_NAME,
              },
            }
          : {}),
        getToolCorrelation: correlation,
      };
    }

    // Agentic mode off on the legacy path → pure analyst with no tools.
    if (!agentic) {
      return {
        vaultRoot: this.vaultRoot,
        useSdk,
        ...contextWindow,
        generation: handle,
        getToolCorrelation: correlation,
      };
    }

    // Fallback path (incompatible/missing CLI): the legacy loopback-HTTP bridge,
    // scoped to this generation. A new generation never reuses the old server as a
    // callback target (settled decision 17).
    legacyServer = new VaultMcpServer(
      MCP_SERVER_NAME,
      this.createCallbackProvider(handle),
    );
    const serverHandle = await legacyServer.start();
    return {
      vaultRoot: this.vaultRoot,
      useSdk,
      ...contextWindow,
      generation: handle,
      mcp: {
        configJson: buildMcpConfigJson(MCP_SERVER_NAME, serverHandle),
        allowedTools: `mcp__${MCP_SERVER_NAME}`,
      },
      getToolCorrelation: correlation,
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
    handle: ClaudeCodeGenerationHandle,
    input: SdkSessionTurnInput,
    agentic: boolean,
    resumeCursor?: ClaudeCodeResumeCursor,
  ): AsyncGenerator<AssistantCaptureFrame> {
    const toolNames = agentic
      ? this.stableToolNames()
      : [];
    const cfg: SessionConfig = {
      model: input.model,
      systemPrompt: input.systemPrompt,
      agenticMode: agentic,
      toolNames,
    };

    const command = this.command;
    const vaultRoot = this.vaultRoot;
    const buildOptions = (
      abortController: AbortController,
      resumeSessionId?: string,
      processOwner?: ClaudeCodeProcessOwner,
    ): Options => {
      // Reached only on a cold mint or a disk resume, so this is exactly where a
      // new `claude` process gets a new callback surface. The displaced one is
      // tombstoned with the session it belonged to.
      const sdkMcp = agentic
        ? {
            server: createVaultSdkMcpServer(
              MCP_SERVER_NAME,
              this.createCallbackProvider(handle, this.openSessionSlot(conversationId)),
            ),
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
          // Present only on a disk resume (Model A′): loads the session history from
          // ~/.claude so only the delta turn need be sent.
          ...(resumeSessionId ? { resume: resumeSessionId } : {}),
          // The session's own spawn owner, so its disposal has a bounded hard tier.
          ...(processOwner ? { processOwner } : {}),
        },
        abortController,
      );
    };

    return this.sessionRegistry.runTurnEvents(conversationId, {
      cfg,
      effort: input.reasoning ?? null,
      turns: input.turns,
      fullPrompt: input.fullPrompt,
      deltaPrompt: input.deltaPrompt,
      buildOptions,
      ...(resumeCursor ? { resumeCursor } : {}),
      signal: input.signal,
      onResult: input.onResult,
      onRecoveryDecision: input.onRecoveryDecision,
      onSessionBanked: input.onSessionBanked,
      ...(this.onEffortLevelsDiscovered
        ? {
            onModelsDiscovered: (models) =>
              this.onEffortLevelsDiscovered?.(harvestEffortLevels(models)),
          }
        : {}),
    });
  }

  /**
   * The advertised tool NAMES, read from the same catalogue function the callback
   * surface advertises, so the `SessionConfig.toolNames` fingerprint cannot drift
   * from it (prompt-cache design section 6.1.1).
   */
  private stableToolNames(): string[] {
    return claudeCodeStableToolSet(this.getSettings().memoriesEnabled).map(
      (definition) => definition.name,
    );
  }

  /**
   * Builds a callback surface for one generation, over its own slot unless the
   * caller supplies the one a freshly minted session will answer through. Either
   * way the slot is registered on the handle, so the generation's lease reaches it
   * whether the surface was built before activation or after it.
   */
  private createCallbackProvider(
    handle: ClaudeCodeGenerationHandle,
    slot: ClaudeCodeRunSlot = new ClaudeCodeRunSlot(),
  ) {
    handle.registerSlot(slot);
    const deps: ClaudeCodeCallbackDeps = {
      app: this.app,
      getSettings: this.getSettings,
      getRagService: this.getRagService,
      getMemoryService: this.getMemoryService,
      persistSettings: this.persistSettings,
    };
    return createClaudeCodeCallbackProvider(deps, slot);
  }

  /**
   * Opens the callback surface a freshly minted session will answer through,
   * retiring the one it displaces. The old slot is tombstoned rather than dropped
   * silently, because its `claude` process may still be unwinding and must be
   * refused rather than answered (settled decision 18).
   */
  private openSessionSlot(conversationId: string): ClaudeCodeRunSlot {
    this.sessionSlots.get(conversationId)?.tombstone();
    const slot = new ClaudeCodeRunSlot();
    this.sessionSlots.set(conversationId, slot);
    return slot;
  }

  /**
   * Hands a live session's existing callback surface to the next generation. A
   * surface that is tombstoned, or that a prior generation never released, is not
   * taken over: it is retired and its session disposed, so this turn cold-rebuilds
   * onto a clean surface rather than sharing one whose ownership cannot be proven
   * (plan section 8.2).
   */
  private adoptSessionSlot(
    conversationId: string,
    handle: ClaudeCodeGenerationHandle,
  ): void {
    const slot = this.sessionSlots.get(conversationId);
    if (!slot) return;
    if (slot.isTombstoned || !slot.isEmpty) {
      slot.tombstone();
      this.sessionSlots.delete(conversationId);
      void this.sessionRegistry.disposeConversation(conversationId);
      return;
    }
    handle.registerSlot(slot);
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

  /**
   * Plugin teardown. Every generation still holding a surface is tombstoned, which
   * refuses any callback already dispatched, cancels the interaction it can no
   * longer answer, and stops its run-scoped loopback server. Synchronous, because
   * `onunload` cannot await; the in-flight callback that has already entered is
   * accounted for by its lease rather than waited on here.
   */
  destroy(): void {
    for (const handle of [...this.liveHandles]) handle.tombstone();
    this.liveHandles.clear();
    for (const slot of this.sessionSlots.values()) slot.tombstone();
    this.sessionSlots.clear();
    // Kill every live SDK process, the "don't leak processes" rule. Each
    // disposal issues its kill synchronously, so the children die even though
    // `onunload` cannot await; the returned exit proof has no caller here.
    void this.sessionRegistry.disposeAll();
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

import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../../src/constants";
import { MemoryService } from "../../../src/memory/MemoryService";
import type { McpToolProvider } from "../../../src/mcp/VaultMcpServer";
import {
  ClaudeCodeService,
  type ClaudeCodeToolEvent,
} from "../../../src/services/ClaudeCodeService";
import type { PluginSettings } from "../../../src/shared/types";
import type { ToolCall, ToolResult, VaultOpReviewer } from "../../../src/tools/types";
import { DEFAULT_VAULT_OP_POLICY } from "../../../src/vault-ops/gateway";

/**
 * RFC-0011 phase 0: Claude Code callback ownership characterization.
 *
 * The MCP tool provider is created once and captured by the SDK server or the
 * loopback server. It reads mutable `ClaudeCodeService` fields at call time, so a
 * callback that arrives after generation cleanup, or after a newer generation
 * installed its own owners, is answered by whatever those fields hold now.
 *
 * `it.fails` cases state the invariant RFC-0011 requires and turn red when
 * phase 5 lands attempt-scoped generation leases.
 */

function app(): App {
  return {
    vault: {
      configDir: ".obsidian",
      getName: () => "Vault",
      getAbstractFileByPath: () => null,
      getFileByPath: () => null,
      getFolderByPath: () => null,
      getAllLoadedFiles: () => [],
      adapter: {},
    },
    workspace: { getActiveFile: () => null },
  } as unknown as App;
}

function settings(): PluginSettings {
  return {
    ...DEFAULT_SETTINGS,
    agenticMode: true,
    memoriesEnabled: false,
    vaultOpPolicy: { ...DEFAULT_VAULT_OP_POLICY },
  };
}

interface ServiceSeam {
  createToolProvider(): McpToolProvider;
  runAllowedTools: Set<string>;
  liveReview: VaultOpReviewer | null;
  toolListener: ((event: ClaudeCodeToolEvent) => void) | null;
  collectedVaultOps: ToolCall[];
  sdkUsable: Promise<boolean> | null;
}

function harness() {
  const currentSettings = settings();
  const memoryService = new MemoryService(() => currentSettings.memories);
  const service = new ClaudeCodeService(
    app(),
    () => currentSettings,
    () => ({ isReady: () => false }) as never,
    () => memoryService,
    async () => undefined,
  );
  const seam = service as unknown as ServiceSeam;
  seam.sdkUsable = Promise.resolve(true);
  // One provider instance, exactly as an SDK MCP server or the loopback server
  // captures it for the lifetime of its callback surface.
  return { service, seam, provider: seam.createToolProvider() };
}

function reviewer(label: string, seen: string[]): VaultOpReviewer {
  return {
    resolveOne: (call: ToolCall): Promise<ToolResult> => {
      seen.push(`${label}:${call.name}`);
      return Promise.resolve({ content: `${label} approved`, isError: false });
    },
    resolveEditOne: (call: ToolCall): Promise<ToolResult> => {
      seen.push(`${label}:${call.name}`);
      return Promise.resolve({ content: `${label} approved`, isError: false });
    },
    resolveMemoryOne: (call: ToolCall): Promise<ToolResult> => {
      seen.push(`${label}:${call.name}`);
      return Promise.resolve({ content: `${label} approved`, isError: false });
    },
  } as unknown as VaultOpReviewer;
}

function vaultOpCall(id: string): ToolCall {
  return {
    id,
    name: "write_file",
    arguments: { path: "Notes/late.md", content: "late" },
  };
}

describe("Claude Code late callback ownership", () => {
  it("routes a late callback to the fallback executor after cleanup clears the review owner", async () => {
    const { seam, provider } = harness();
    const seen: string[] = [];
    seam.runAllowedTools = new Set(["write_file"]);
    seam.liveReview = reviewer("run-a", seen);

    await provider.callTool(vaultOpCall("toolu_during"));
    expect(seen).toEqual(["run-a:write_file"]);

    // Generation cleanup, exactly as the finally block in generateLlmResponse
    // does it: the owners go away while the provider run may still be alive.
    seam.liveReview = null;
    seam.toolListener = null;

    const late = await provider.callTool(vaultOpCall("toolu_late"));

    // Invariant 13 and criterion 24: no callback enters after its lease begins
    // stopping, and none may fall through to a path that was not the authorized
    // one. The late call instead reached the collect-for-later fallback.
    expect(seen).toEqual(["run-a:write_file"]);
    expect(late.isError ?? false).toBe(false);
    expect(seam.collectedVaultOps.map((op) => op.id)).toEqual(["toolu_late"]);
  });

  // Criterion 24, fixed in phase 5.
  it.fails("refuses a callback that arrives after its generation released its owners", async () => {
    const { seam, provider } = harness();
    seam.runAllowedTools = new Set(["write_file"]);
    seam.liveReview = reviewer("run-a", []);
    await provider.callTool(vaultOpCall("toolu_during"));

    seam.liveReview = null;
    seam.toolListener = null;
    const late = await provider.callTool(vaultOpCall("toolu_late"));

    expect(late.isError).toBe(true);
  });

  it("routes an old run's callback into the next generation's review owner", async () => {
    const { seam, provider } = harness();
    const seen: string[] = [];
    seam.runAllowedTools = new Set(["write_file"]);
    seam.liveReview = reviewer("run-a", seen);

    // Generation A ends and generation B installs its own owners. The captured
    // provider is unchanged, so a straggler from A reads B's fields.
    seam.liveReview = reviewer("run-b", seen);
    await provider.callTool(vaultOpCall("toolu_from_run_a"));

    // Invariant 13 and criterion 27: a callback from an old attempt cannot
    // observe or mutate a new attempt.
    expect(seen).toEqual(["run-b:write_file"]);
  });

  // Criterion 27, fixed in phase 5.
  it.fails("keeps an old run's callback away from the next generation", async () => {
    const { seam, provider } = harness();
    const seen: string[] = [];
    seam.runAllowedTools = new Set(["write_file"]);
    seam.liveReview = reviewer("run-a", seen);
    seam.liveReview = reviewer("run-b", seen);

    await provider.callTool(vaultOpCall("toolu_from_run_a"));

    expect(seen).toEqual([]);
  });

  it("emits a late lifecycle event into whichever listener is installed now", async () => {
    const { seam, provider } = harness();
    const runA: ClaudeCodeToolEvent[] = [];
    const runB: ClaudeCodeToolEvent[] = [];
    seam.runAllowedTools = new Set(["read_file"]);
    seam.toolListener = (event) => runA.push(event);
    seam.toolListener = (event) => runB.push(event);

    await provider.callTool({
      id: "toolu_late_read",
      name: "read_file",
      arguments: { path: "Notes/late.md" },
    });

    expect(runA).toHaveLength(0);
    expect(runB.length).toBeGreaterThan(0);
  });

  it("has no admission gate a caller could consult before entering", () => {
    const { provider } = harness();
    const surface = provider as unknown as Record<string, unknown>;

    // Criterion 23 to 26 need a lease with `enterCallback`, in-flight
    // accounting, and a cancellation signal. None exists yet.
    expect(typeof surface.enterCallback).toBe("undefined");
    expect(typeof surface.lease).toBe("undefined");
  });

  it("destroys without waiting for an in-flight callback", async () => {
    const { service, seam, provider } = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    seam.runAllowedTools = new Set(["write_file"]);
    seam.liveReview = {
      resolveOne: async (): Promise<ToolResult> => {
        await gate;
        return { content: "approved", isError: false };
      },
    } as unknown as VaultOpReviewer;

    const pending = provider.callTool(vaultOpCall("toolu_inflight"));
    const disposeAll = vi.fn();
    (service as unknown as { sessionRegistry: { disposeAll: () => void } }).sessionRegistry = {
      disposeAll,
    };

    service.destroy();
    // Criterion 20: settlement must account for zero in-flight callbacks.
    // `destroy()` returns void and cannot be awaited.
    expect(disposeAll).toHaveBeenCalledTimes(1);

    release();
    await expect(pending).resolves.toMatchObject({ isError: false });
  });
});

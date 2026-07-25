import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { DEFAULT_SETTINGS } from "../../../src/constants";
import { MemoryService } from "../../../src/memory/MemoryService";
import type { PluginSettings } from "../../../src/shared/types";
import { ClaudeCodeService } from "../../../src/services/ClaudeCodeService";
import type { McpToolProvider } from "../../../src/mcp/VaultMcpServer";
import type { ToolCall, ToolResult, VaultOpReviewer } from "../../../src/tools/types";
import { CLAUDE_CODE_STABLE_TOOL_SET } from "../../../src/tools/toolSurface";

function app(): App {
  return {
    vault: {
      configDir: ".obsidian",
      getName: () => "Vault",
      getAbstractFileByPath: () => null,
    },
    workspace: {
      getActiveFile: () => null,
    },
  } as unknown as App;
}

function settings(): PluginSettings {
  return {
    ...DEFAULT_SETTINGS,
    memoriesEnabled: true,
    memories: [
      {
        name: "vault-tone",
        type: "context",
        description: "Tone guide, recall when writing scene mood.",
        content: "Keep the atmosphere restrained and uncanny.",
        enabled: true,
      },
    ],
  };
}

type ClaudeCodeTestSeam = {
  createToolProvider(): McpToolProvider;
  runAllowedTools: Set<string>;
  liveReview: VaultOpReviewer | null;
};

function harness() {
  const currentSettings = settings();
  const memoryService = new MemoryService(() => currentSettings.memories);
  const saveSettings = vi.fn(async () => undefined);
  const service = new ClaudeCodeService(
    app(),
    () => currentSettings,
    () => ({}) as never,
    () => memoryService,
    saveSettings,
  );
  const seam = service as unknown as ClaudeCodeTestSeam;
  return {
    currentSettings,
    memoryService,
    saveSettings,
    service,
    seam,
    provider: seam.createToolProvider(),
  };
}

function call(name: string, arguments_: Record<string, unknown>): ToolCall {
  return { id: "mcp-call", name, arguments: arguments_ };
}

describe("ClaudeCodeService memory tools", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("advertises the enabled stable memory family invariantly across memory policies", () => {
    const { currentSettings, provider } = harness();
    const baseline = JSON.stringify(provider.listTools());

    expect(provider.listTools().map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["recall_memory", "add_memory", "forget_memory"]),
    );
    for (const memory of ["ask", "auto", "deny"] as const) {
      currentSettings.vaultOpPolicy.memory = memory;
      expect(JSON.stringify(provider.listTools())).toBe(baseline);
    }
  });

  it("keeps the advertised MCP catalog byte-identical to baseline while off", () => {
    const { currentSettings, provider } = harness();
    currentSettings.memoriesEnabled = false;
    expect(JSON.stringify(provider.listTools())).toBe(
      JSON.stringify(CLAUDE_CODE_STABLE_TOOL_SET),
    );
  });

  it("dispatches recall_memory to the current store", async () => {
    const { seam, provider } = harness();
    seam.runAllowedTools = new Set(["recall_memory"]);

    const result = await provider.callTool(
      call("recall_memory", { names: ["vault-tone"] }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.isReadOnly).toBe(true);
    expect(result.content).toContain('"status":"hit"');
    expect(result.content).toContain("restrained and uncanny");
  });

  it("dispatches a mutation through resolveMemoryOne with the MCP call id", async () => {
    const { seam, provider } = harness();
    seam.runAllowedTools = new Set(["add_memory"]);
    const applied: ToolResult = {
      content: 'Added memory "new-rule".',
      isReadOnly: false,
      disposition: "applied",
    };
    const resolveMemoryOne = vi.fn(async () => applied);
    seam.liveReview = {
      resolveOne: vi.fn(),
      resolveEditOne: vi.fn(),
      resolveMemoryOne,
    };
    const mutation = call("add_memory", {
      name: "new-rule",
      type: "rule",
      description: "Keep replies concise.",
    });

    const result = await provider.callTool(mutation);

    expect(result).toBe(applied);
    expect(resolveMemoryOne).toHaveBeenCalledWith(mutation, "mcp-call");
  });

  it("refuses a denied mutation at runtime even though the stable catalog advertises it", async () => {
    const { seam, provider } = harness();
    seam.runAllowedTools = new Set(["recall_memory"]);

    const result = await provider.callTool(
      call("forget_memory", { name: "vault-tone" }),
    );

    expect(result.isError).toBe(true);
    expect(result.failure?.kind).toBe("precondition");
    expect(result.content).toContain("not permitted");
  });
});

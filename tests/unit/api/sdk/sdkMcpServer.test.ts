import { describe, it, expect, vi } from "vitest";
import {
  buildVaultSdkTools,
  extractClaudeCodeToolUseId,
} from "../../../../src/api/sdk/sdkMcpServer";
import {
  CLAUDE_CODE_STABLE_TOOL_SET,
  isAlwaysLoadedCoreTool,
} from "../../../../src/tools/toolSurface";
import type {
  McpToolCallContext,
  McpToolProvider,
} from "../../../../src/mcp/VaultMcpServer";
import type { ToolCall } from "../../../../src/tools/types";
import type { ToolResult } from "../../../../src/tools/types";

// Faithful provider: lists exactly the constant Claude Code stable superset (what the
// real ClaudeCodeService.createToolProvider advertises). callTool is never invoked here.
const provider: McpToolProvider = {
  listTools: () => CLAUDE_CODE_STABLE_TOOL_SET,
  callTool: async (): Promise<ToolResult> => ({ content: "", isReadOnly: true }),
};

/** Reads the SDK's per-tool alwaysLoad marker (`_meta['anthropic/alwaysLoad']`). */
function alwaysLoadOf(meta: Record<string, unknown> | undefined): unknown {
  return meta?.["anthropic/alwaysLoad"];
}

describe("buildVaultSdkTools (Layer-2 core/tail alwaysLoad split, ADR-0009)", () => {
  const tools = buildVaultSdkTools(provider);

  it("marks every core read alwaysLoad and leaves the tail deferrable", () => {
    for (const t of tools) {
      if (isAlwaysLoadedCoreTool(t.name)) {
        expect(alwaysLoadOf(t._meta), `${t.name} (core) must be alwaysLoad`).toBe(true);
      } else {
        expect(alwaysLoadOf(t._meta), `${t.name} (tail) must stay deferrable`).toBeUndefined();
      }
    }
  });

  it("marks ask_user alwaysLoad exactly once with the core reads", () => {
    const alwaysLoaded = tools
      .filter((t) => alwaysLoadOf(t._meta) === true)
      .map((t) => t.name)
      .sort();
    const expectedCore = CLAUDE_CODE_STABLE_TOOL_SET.filter((d) => isAlwaysLoadedCoreTool(d.name))
      .map((d) => d.name)
      .sort();
    expect(alwaysLoaded).toEqual(expectedCore);
    // The Claude Code core is the 6 retrieval / navigation reads plus ask_user.
    // `think` is not bridged to Claude Code, so it never lands here.
    expect(alwaysLoaded).toHaveLength(7);
    expect(alwaysLoaded.filter((name) => name === "ask_user")).toHaveLength(1);
  });

  it("does not perturb the advertised tool names (the toolNames fingerprint is unchanged)", () => {
    // alwaysLoad is `_meta`, not a name; the bridged names must equal listTools() exactly,
    // in order, so SessionConfig.toolNames (built separately from listTools) cannot drift.
    expect(tools.map((t) => t.name)).toEqual(provider.listTools().map((d) => d.name));
  });
});

describe("extractClaudeCodeToolUseId", () => {
  it("accepts only the exact own metadata property and preserves its bytes", () => {
    expect(
      extractClaudeCodeToolUseId({
        _meta: {
          "claudecode/toolUseId": " toolu_exact ",
        },
      }),
    ).toBe(" toolu_exact ");
  });

  it.each([
    ["absent", undefined],
    ["array extra", []],
    ["array metadata", { _meta: [] }],
    ["number", { _meta: { "claudecode/toolUseId": 7 } }],
    ["empty", { _meta: { "claudecode/toolUseId": "" } }],
    ["blank", { _meta: { "claudecode/toolUseId": "   " } }],
    ["alternate key", { _meta: { toolUseId: "toolu_wrong" } }],
    ["alternate namespace", { _meta: { "claudeCode/toolUseId": "toolu_wrong" } }],
  ])("rejects %s metadata", (_label, extra) => {
    expect(extractClaudeCodeToolUseId(extra)).toBeNull();
  });

  it("rejects inherited lookalikes at both object levels", () => {
    const inheritedExtra = Object.create({
      _meta: { "claudecode/toolUseId": "toolu_inherited_extra" },
    });
    const inheritedMeta = Object.create({
      "claudecode/toolUseId": "toolu_inherited_meta",
    });

    expect(extractClaudeCodeToolUseId(inheritedExtra)).toBeNull();
    expect(extractClaudeCodeToolUseId({ _meta: inheritedMeta })).toBeNull();
  });
});

describe("buildVaultSdkTools tool-use ID threading", () => {
  it("passes the exact metadata ID into McpToolProvider.callTool", async () => {
    const calls: Array<{
      call: ToolCall;
      context: McpToolCallContext | undefined;
    }> = [];
    const exactProvider: McpToolProvider = {
      listTools: () => [CLAUDE_CODE_STABLE_TOOL_SET[0]],
      callTool: vi.fn(async (call, context) => {
        calls.push({ call, context });
        return { content: "ok", isReadOnly: true };
      }),
    };
    const [definition] = buildVaultSdkTools(exactProvider);

    await definition.handler(
      {},
      {
        _meta: {
          "claudecode/toolUseId": "toolu_fixture_exact",
        },
        requestId: 42,
      },
    );

    expect(calls).toEqual([{
      call: {
        id: "toolu_fixture_exact",
        name: definition.name,
        arguments: {},
      },
      context: {
        toolCorrelation: "provider_id",
      },
    }]);
  });

  it("never substitutes a request ID or generated ID when metadata is absent", async () => {
    const calls: Array<{
      call: ToolCall;
      context: McpToolCallContext | undefined;
    }> = [];
    const degradedProvider: McpToolProvider = {
      listTools: () => [CLAUDE_CODE_STABLE_TOOL_SET[0]],
      callTool: vi.fn(async (call, context) => {
        calls.push({ call, context });
        return { content: "ok", isReadOnly: true };
      }),
    };
    const [definition] = buildVaultSdkTools(degradedProvider);

    await definition.handler({}, { requestId: 73 });

    expect(calls).toEqual([{
      call: {
        id: "",
        name: definition.name,
        arguments: {},
      },
      context: {
        toolCorrelation: "none",
        transport: "claude-agent-sdk",
        reason: "claude_code_tool_use_id_missing",
      },
    }]);
    expect(calls[0].call.id).not.toBe("73");
  });
});

import { describe, it, expect } from "vitest";
import { buildVaultSdkTools } from "../../../../src/api/sdk/sdkMcpServer";
import {
  CLAUDE_CODE_STABLE_TOOL_SET,
  isAlwaysLoadedCoreTool,
} from "../../../../src/tools/toolSurface";
import type { McpToolProvider } from "../../../../src/mcp/VaultMcpServer";
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

  it("the always-loaded core is exactly the core reads in the stable set (small, no think)", () => {
    const alwaysLoaded = tools
      .filter((t) => alwaysLoadOf(t._meta) === true)
      .map((t) => t.name)
      .sort();
    const expectedCore = CLAUDE_CODE_STABLE_TOOL_SET.filter((d) => isAlwaysLoadedCoreTool(d.name))
      .map((d) => d.name)
      .sort();
    expect(alwaysLoaded).toEqual(expectedCore);
    // The Claude Code core is the 6 retrieval / navigation reads; `think` is not bridged
    // to Claude Code, so it never lands here. A change to this number is a real signal.
    expect(alwaysLoaded).toHaveLength(6);
    expect(tools.map((tool) => tool.name)).not.toContain("ask_user");
  });

  it("does not perturb the advertised tool names (the toolNames fingerprint is unchanged)", () => {
    // alwaysLoad is `_meta`, not a name; the bridged names must equal listTools() exactly,
    // in order, so SessionConfig.toolNames (built separately from listTools) cannot drift.
    expect(tools.map((t) => t.name)).toEqual(provider.listTools().map((d) => d.name));
  });
});

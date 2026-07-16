import { jsonSchemaToZodShape } from "../../mcp/sdkToolSchema";
import type { ZodRawShape } from "../../mcp/sdkToolSchema";
import type { McpToolProvider } from "../../mcp/VaultMcpServer";
import { generateId } from "../../utils";
import { isCoreReadTool } from "../../tools/toolSurface";
import { createSdkMcpServer, tool } from "./claudeAgentSdk";
import type { McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from "./claudeAgentSdk";

/**
 * Builds the SDK `tool()` definitions the bridge advertises, applying the Layer-2
 * core/tail split as per-tool `alwaysLoad` (ADR-0009 / prompt-cache design section 6.2.4,
 * section 6.2.5). This is the Claude Code analogue of the direct-API defer split: the core
 * reads ({@link isCoreReadTool}, the retrieval / navigation primitives) carry
 * `alwaysLoad: true` so they stay in the prompt, and the tail (the rest of the reads +
 * every write) is left deferrable, so once the CLI / model layer enables tool search the
 * model discovers a tail tool on demand instead of paying for its schema every turn.
 * `think` is never bridged to Claude Code, so it cannot appear here; the split is exactly
 * {@link isCoreReadTool}.
 *
 * `alwaysLoad` rides as `_meta['anthropic/alwaysLoad']` metadata, NOT a tool name, and is
 * inert when tool search is not enabled (the SDK only defers behind tool search). The
 * advertised tool NAMES are untouched, so the `SessionConfig.toolNames` fingerprint, which
 * {@link ../../services/ClaudeCodeService} builds separately from the same
 * `provider.listTools()`, does not drift and the live session is not cold-rebuilt
 * (prompt-cache design section 6.1.1). Extracted from {@link createVaultSdkMcpServer} so the split
 * is unit-testable without standing up the live MCP server instance.
 */
export function buildVaultSdkTools(
  provider: McpToolProvider,
): SdkMcpToolDefinition<ZodRawShape>[] {
  return provider.listTools().map((definition) =>
    tool(
      definition.name,
      definition.description,
      jsonSchemaToZodShape(definition.parameters),
      async (args) => {
        const result = await provider.callTool({
          id: generateId(),
          name: definition.name,
          arguments: (args ?? {}),
        });
        return {
          content: [{ type: "text", text: result.content }],
          isError: result.isError ?? false,
        };
      },
      isCoreReadTool(definition.name) ? { alwaysLoad: true } : undefined,
    ),
  );
}

/**
 * Builds the in-process MCP server that bridges the plugin's toolstack to a
 * Claude Code session over the Agent SDK. Replaces the hand-rolled loopback-HTTP
 * {@link ../../mcp/VaultMcpServer.VaultMcpServer} on the SDK path: no port, no
 * bearer token, no subprocess round-trip, the model's tool calls invoke the same
 * {@link McpToolProvider} executors directly in this process.
 *
 * The advertised tool set is fixed at build time from `provider.listTools()` (via
 * {@link buildVaultSdkTools}, which also applies the Layer-2 `alwaysLoad` core/tail
 * split), so the caller rebuilds the server whenever the exposed tools change (e.g. edit
 * mode toggling the edit tools on), mirroring the legacy server's per-request listing.
 */
export function createVaultSdkMcpServer(
  serverName: string,
  provider: McpToolProvider,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: serverName,
    version: "1.0.0",
    tools: buildVaultSdkTools(provider),
  });
}

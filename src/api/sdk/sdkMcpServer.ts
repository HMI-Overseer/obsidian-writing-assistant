import { jsonSchemaToZodShape } from "../../mcp/sdkToolSchema";
import type { McpToolProvider } from "../../mcp/VaultMcpServer";
import { generateId } from "../../utils";
import { createSdkMcpServer, tool } from "./claudeAgentSdk";
import type { McpSdkServerConfigWithInstance } from "./claudeAgentSdk";

/**
 * Builds the in-process MCP server that bridges the plugin's toolstack to a
 * Claude Code session over the Agent SDK. Replaces the hand-rolled loopback-HTTP
 * {@link ../../mcp/VaultMcpServer.VaultMcpServer} on the SDK path: no port, no
 * bearer token, no subprocess round-trip, the model's tool calls invoke the same
 * {@link McpToolProvider} executors directly in this process.
 *
 * The advertised tool set is fixed at build time from `provider.listTools()`, so
 * the caller rebuilds the server whenever the exposed tools change (e.g. edit mode
 * toggling the edit tools on), mirroring the legacy server's per-request listing.
 */
export function createVaultSdkMcpServer(
  serverName: string,
  provider: McpToolProvider,
): McpSdkServerConfigWithInstance {
  const tools = provider.listTools().map((definition) =>
    tool(
      definition.name,
      definition.description,
      jsonSchemaToZodShape(definition.parameters),
      async (args) => {
        const result = await provider.callTool({
          id: generateId(),
          name: definition.name,
          arguments: (args ?? {}) as Record<string, unknown>,
        });
        return {
          content: [{ type: "text", text: result.content }],
          isError: result.isError ?? false,
        };
      },
    ),
  );

  return createSdkMcpServer({ name: serverName, version: "1.0.0", tools });
}

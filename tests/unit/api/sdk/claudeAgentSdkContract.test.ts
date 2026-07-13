import { describe, expect, it } from "vitest";
import {
  createSdkMcpServer,
  isSdkAvailable,
  tool,
} from "../../../../src/api/sdk/claudeAgentSdk";
import { jsonSchemaToZodShape } from "../../../../src/mcp/sdkToolSchema";

describe("Claude Agent SDK runtime contract", () => {
  it("loads the real SDK exports used by the plugin", () => {
    expect(isSdkAvailable()).toBe(true);
    expect(createSdkMcpServer).toBeTypeOf("function");
    expect(tool).toBeTypeOf("function");
  });

  it("constructs the in-process tool and MCP server shapes used by the plugin", () => {
    const echo = tool(
      "echo",
      "Returns the supplied value.",
      jsonSchemaToZodShape({
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      }),
      async (args) => ({
        content: [{ type: "text", text: String(args.value) }],
      }),
    );

    const server = createSdkMcpServer({
      name: "writing-assistant-contract",
      version: "1.0.0",
      tools: [echo],
    });

    expect(echo).toMatchObject({ name: "echo", description: "Returns the supplied value." });
    expect(echo.handler).toBeTypeOf("function");
    expect(server).toMatchObject({ type: "sdk", name: "writing-assistant-contract" });
    expect(server.instance).toBeDefined();
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { VaultMcpServer, type McpServerHandle, type McpToolProvider } from "../../../src/mcp/VaultMcpServer";
import type { CanonicalToolDefinition, ToolCall } from "../../../src/tools/types";

const TOOL: CanonicalToolDefinition = {
  name: "echo",
  description: "Echoes its input.",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};

const calls: ToolCall[] = [];

const provider: McpToolProvider = {
  listTools: () => [TOOL],
  callTool: (call) => {
    calls.push(call);
    if (call.name !== "echo") {
      return Promise.resolve({ content: "unknown", isReadOnly: true, isError: true });
    }
    return Promise.resolve({ content: `echo:${String(call.arguments.text)}`, isReadOnly: true });
  },
};

let server: VaultMcpServer;
let handle: McpServerHandle;

async function rpc(body: unknown, token = handle.token): Promise<Response> {
  return fetch(handle.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  server = new VaultMcpServer("writing_assistant", provider);
  handle = await server.start();
});

afterAll(() => server.stop());

describe("VaultMcpServer", () => {
  it("rejects requests without the bearer token", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "wrong-token");
    expect(res.status).toBe(401);
  });

  it("rejects a same-length but wrong token (constant-time content check is load-bearing)", async () => {
    // Same length as the real token, so the length short-circuit can't be what
    // rejects it, only the timingSafeEqual content comparison can.
    const last = handle.token.slice(-1);
    const sameLengthWrong = handle.token.slice(0, -1) + (last === "0" ? "1" : "0");
    expect(sameLengthWrong.length).toBe(handle.token.length);
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, sameLengthWrong);
    expect(res.status).toBe(401);
  });

  it("answers initialize, echoing the requested protocol version", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    const json = await res.json();
    expect(json.result.protocolVersion).toBe("2025-06-18");
    expect(json.result.serverInfo.name).toBe("writing_assistant");
    expect(json.result.capabilities.tools).toBeDefined();
  });

  it("lists tools in MCP inputSchema shape", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const json = await res.json();
    expect(json.result.tools).toHaveLength(1);
    expect(json.result.tools[0]).toMatchObject({ name: "echo", inputSchema: { type: "object" } });
  });

  it("dispatches tools/call to the provider and returns text content", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "hi" } },
    });
    const json = await res.json();
    expect(json.result.content).toEqual([{ type: "text", text: "echo:hi" }]);
    expect(json.result.isError).toBe(false);
    expect(calls.at(-1)).toMatchObject({ name: "echo", arguments: { text: "hi" } });
  });

  it("returns 202 with no body for notifications", async () => {
    const res = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("returns a JSON-RPC error for unknown methods", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 4, method: "does/not/exist" });
    const json = await res.json();
    expect(json.error.code).toBe(-32601);
  });

  it("returns 405 for GET (no server-initiated stream)", async () => {
    const res = await fetch(handle.url, {
      method: "GET",
      headers: { Authorization: `Bearer ${handle.token}` },
    });
    expect(res.status).toBe(405);
  });
});

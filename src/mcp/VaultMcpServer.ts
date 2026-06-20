import * as http from "http";
import { randomBytes } from "crypto";
import type { CanonicalToolDefinition, ToolCall, ToolResult } from "../tools/types";
import { toMcpToolSchema } from "./toolSchema";

/**
 * Minimal in-process MCP server (stateless Streamable-HTTP transport) that
 * exposes the plugin's toolstack to a Claude Code subprocess.
 *
 * Claude Code connects as an HTTP MCP client (`--mcp-config`). We answer the
 * JSON-RPC `initialize` / `tools/list` / `tools/call` methods with a single
 * `application/json` response each, no SSE, no session state. The server binds
 * to loopback on an ephemeral port and requires a per-session bearer token, so no
 * other local process can reach it.
 *
 * This is hand-rolled (rather than pulling in `@modelcontextprotocol/sdk`) to
 * match the codebase's existing hand-rolled HTTP/SSE transports and avoid a heavy
 * bundled dependency. The protocol surface a controlled, known client needs is
 * small.
 */

/** Protocol version used if the client doesn't request one. */
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

/** Reject request bodies larger than this (defensive, tool args are small). */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Supplies the tools advertised and executed over MCP. */
export interface McpToolProvider {
  listTools(): CanonicalToolDefinition[];
  callTool(call: ToolCall): Promise<ToolResult>;
}

export interface McpServerHandle {
  /** Full endpoint URL, e.g. http://127.0.0.1:51234/mcp */
  url: string;
  /** Bearer token required in the Authorization header. */
  token: string;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export class VaultMcpServer {
  private server: http.Server | null = null;
  private token = "";
  private endpoint = "";

  constructor(
    /** MCP server key, must match `^[a-zA-Z0-9_-]+$`; becomes the `mcp__<name>__*` tool prefix. */
    private readonly serverName: string,
    private readonly provider: McpToolProvider,
  ) {}

  isRunning(): boolean {
    return this.server !== null;
  }

  /** Starts the server (idempotent) and returns its connection handle. */
  async start(): Promise<McpServerHandle> {
    if (this.server) return { url: this.endpoint, token: this.token };

    this.token = randomBytes(24).toString("hex");
    const server = http.createServer((req, res) => {
      void this.handle(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    this.server = server;
    this.endpoint = `http://127.0.0.1:${port}/mcp`;
    return { url: this.endpoint, token: this.token };
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Loopback bind + bearer token: nothing else on the machine can call us.
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      res.writeHead(401).end();
      return;
    }

    // The transport is request/response only; we never push server-initiated
    // messages, so GET (SSE stream) is unsupported and DELETE is a no-op.
    if (req.method === "GET") {
      res.writeHead(405).end();
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(413).end();
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      this.respond(res, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }

    if (Array.isArray(payload)) {
      const responses = (await Promise.all(payload.map((m) => this.dispatch(m as JsonRpcMessage))))
        .filter((r): r is object => r !== null);
      if (responses.length === 0) {
        res.writeHead(202).end();
        return;
      }
      this.respond(res, responses);
      return;
    }

    const response = await this.dispatch(payload as JsonRpcMessage);
    if (response === null) {
      res.writeHead(202).end();
      return;
    }
    this.respond(res, response);
  }

  /** Handles one JSON-RPC message. Returns null for notifications (no response). */
  private async dispatch(msg: JsonRpcMessage): Promise<object | null> {
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;

    try {
      switch (method) {
        case "initialize": {
          const requested = params?.protocolVersion;
          const result = {
            protocolVersion: typeof requested === "string" ? requested : DEFAULT_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: this.serverName, version: "1.0.0" },
          };
          return isNotification ? null : { jsonrpc: "2.0", id, result };
        }
        case "tools/list": {
          const result = { tools: this.provider.listTools().map(toMcpToolSchema) };
          return isNotification ? null : { jsonrpc: "2.0", id, result };
        }
        case "tools/call": {
          const name = typeof params?.name === "string" ? params.name : "";
          const args = (params?.arguments as Record<string, unknown> | undefined) ?? {};
          const toolResult = await this.provider.callTool({ id: String(id ?? ""), name, arguments: args });
          // MCP carries only text + isError, so a structured `failure` is flattened to
          // its sentence here, the recovery contract still reaches the model via
          // `content`; the typed kind stays plugin-loop-only (telemetry/UI branching).
          const result = {
            content: [{ type: "text", text: toolResult.content }],
            isError: toolResult.isError ?? false,
          };
          return isNotification ? null : { jsonrpc: "2.0", id, result };
        }
        case "ping":
          return isNotification ? null : { jsonrpc: "2.0", id, result: {} };
        default:
          // Notifications (e.g. notifications/initialized) get no response.
          if (isNotification) return null;
          return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
      }
    } catch (e) {
      if (isNotification) return null;
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: e instanceof Error ? e.message : String(e) },
      };
    }
  }

  private respond(res: http.ServerResponse, body: object): void {
    const json = JSON.stringify(body);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(json),
    });
    res.end(json);
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

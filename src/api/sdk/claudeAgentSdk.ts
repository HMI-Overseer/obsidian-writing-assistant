/**
 * Single dependency boundary for the official Claude Code Agent SDK
 * (`@anthropic-ai/claude-agent-sdk`).
 *
 * Every other module imports the SDK *through here* so the rest of the codebase
 * names one import path, and the SDK↔plugin coupling (version pin, the
 * `import.meta.url`→`createRequire` bundling shim in `esbuild.config.mjs`) is
 * isolated to one place. The session engine consumes `query()` and
 * `createSdkMcpServer()` behind this seam.
 *
 * Distribution note: we never ship the SDK's vendored 245 MB native binary. The
 * engine drives the user's already-installed `claude` CLI via the
 * `pathToClaudeCodeExecutable` option, version-guarded by `sdkVersionGuard.ts`.
 */
import {
  AbortError,
  createSdkMcpServer,
  query,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  McpSdkServerConfigWithInstance,
  ModelInfo,
  Options,
  Query,
  SdkMcpToolDefinition,
  SDKMessage,
  SDKUserMessage,
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { patchRendererAbortSignal } from "./rendererCompat";

// The SDK's query() setup hands a Blink AbortSignal to Node's events module,
// which the Electron renderer realm rejects. Patch the signal prototype once, at
// load, before any query() runs ({@link ./rendererCompat}).
patchRendererAbortSignal();

export { AbortError, createSdkMcpServer, query, tool };
export type {
  McpSdkServerConfigWithInstance,
  ModelInfo,
  Options,
  Query,
  SdkMcpToolDefinition,
  SDKMessage,
  SDKUserMessage,
  SpawnedProcess,
  SpawnOptions,
};

/**
 * Confirms the bundled SDK linked correctly at runtime. The `import.meta.url`
 * shim is the one thing most likely to silently break the SDK in the CJS
 * bundle, so the engine checks this before taking the SDK path and falls back
 * to the legacy one-shot CLI path when it ever returns false.
 */
export function isSdkAvailable(): boolean {
  return (
    typeof query === "function" &&
    typeof createSdkMcpServer === "function" &&
    typeof tool === "function"
  );
}

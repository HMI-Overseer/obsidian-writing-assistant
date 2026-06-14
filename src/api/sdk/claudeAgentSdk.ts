/**
 * Single dependency boundary for the official Claude Code Agent SDK
 * (`@anthropic-ai/claude-agent-sdk`).
 *
 * Every other module imports the SDK *through here* so the rest of the codebase
 * names one import path, and the SDK↔plugin coupling (version pin, the
 * `import.meta.url`→`createRequire` bundling shim in `esbuild.config.mjs`) is
 * isolated to one place. The session engine that consumes `query()` /
 * `createSdkMcpServer()` lands in later phases of the refactor; this module is
 * the seam they build behind.
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
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

export { AbortError, createSdkMcpServer, query, tool };
export type { McpSdkServerConfigWithInstance, Options, Query, SDKMessage, SDKUserMessage };

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

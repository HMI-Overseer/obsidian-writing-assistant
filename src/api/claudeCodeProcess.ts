import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import { existsSync, readFileSync } from "fs";
import * as path from "path";
import { createAbortError } from "./httpTransport";

let cachedBinary: string | null = null;

/**
 * Resolves a directly-spawnable `claude` executable.
 *
 * Node cannot `spawn` a Windows `.cmd`/`.bat` shim without a shell (post-CVE
 * behavior), and shelling out would break argument quoting for the inline MCP
 * config and system prompt. So on Windows we resolve to the real `.exe`: either a
 * native build already on PATH, or the executable an npm shim points at.
 *
 * Returns the configured path verbatim when set, else a resolved absolute path,
 * else the bare command (surfaced as {@link ClaudeCodeNotFoundError} if missing).
 */
export function resolveClaudeBinary(configuredPath: string): string {
  const configured = configuredPath.trim();
  if (configured) return configured;
  if (cachedBinary) return cachedBinary;

  if (process.platform !== "win32") {
    cachedBinary = "claude";
    return cachedBinary;
  }

  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);

  // Prefer a real executable already on PATH (native installer build).
  for (const dir of pathDirs) {
    const exe = path.join(dir, "claude.exe");
    if (existsSync(exe)) {
      cachedBinary = exe;
      return cachedBinary;
    }
  }

  // Otherwise resolve the npm shim (claude.cmd / claude.bat) to its target .exe.
  for (const ext of [".cmd", ".bat"]) {
    for (const dir of pathDirs) {
      const shim = path.join(dir, `claude${ext}`);
      if (!existsSync(shim)) continue;
      const exe = extractExeFromShim(shim);
      if (exe && existsSync(exe)) {
        cachedBinary = exe;
        return cachedBinary;
      }
    }
  }

  cachedBinary = "claude";
  return cachedBinary;
}

/** Extracts the `.exe` path an npm `.cmd`/`.bat` shim invokes, resolving `%dp0%`. */
function extractExeFromShim(shimPath: string): string | null {
  try {
    const content = readFileSync(shimPath, "utf8");
    const match = content.match(/"([^"]*\.exe)"/i);
    if (!match) return null;
    // The shim references its own directory as %dp0% / %~dp0%.
    const resolved = match[1].replace(/%~?dp0%?/i, path.dirname(shimPath) + path.sep);
    return path.normalize(resolved);
  } catch {
    return null;
  }
}

/**
 * Spawns and streams the Claude Code CLI (`claude`) in headless mode.
 *
 * This is the subprocess analogue of `streamingTransport.ts`: it runs the binary
 * with `--output-format stream-json`, parses the line-delimited JSON on stdout,
 * forwards each parsed event to `onEvent`, and yields incremental text deltas.
 *
 * The prompt is piped via stdin (not passed as an argv entry) to avoid OS
 * command-line length limits on large transcripts.
 */

/** Error thrown when the `claude` binary cannot be found or executed. */
export class ClaudeCodeNotFoundError extends Error {
  constructor(public readonly command: string) {
    super(
      `Could not run the Claude Code CLI ("${command}"). Make sure Claude Code is installed and on your PATH.`,
    );
    this.name = "ClaudeCodeNotFoundError";
  }
}

/** Token usage + cost reported by Claude Code's terminal `result` event. */
export interface ClaudeCodeResultUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  /** Claude Code's own cost figure (USD), reported directly, not estimated. */
  costUsd?: number;
  /** Session id for future `--resume` continuation. */
  sessionId?: string;
  /**
   * The model's context-window size (tokens) as Claude Code reports it in the
   * result's `modelUsage`, the CLI's own ground truth, so the plugin never has
   * to guess what window an alias like "opus" resolves to.
   */
  contextWindow?: number;
  /**
   * Prompt tokens (uncached + cache read + cache write) of the turn's *last*
   * internal API call, i.e. the session's current context size. The top-level
   * `usage` aggregates every internal call of an agentic turn, so it overcounts
   * context; this is the number the capacity ring should calibrate against.
   */
  contextTokens?: number;
}

export interface ClaudeCodeSpawnOptions {
  /** Resolved binary path, or a bare command name to resolve from PATH. */
  command: string;
  args: string[];
  /** Working directory for the subprocess (vault root). */
  cwd?: string;
  /** Environment for the subprocess. When set, replaces the inherited env entirely, callers merge `process.env` themselves. */
  env?: NodeJS.ProcessEnv;
  /** Prompt piped to the subprocess stdin. */
  prompt: string;
  signal?: AbortSignal;
  /** Called for every parsed JSON event line on stdout. */
  onEvent?: (json: unknown) => void;
}

/**
 * Extracts an incremental text delta from a Claude Code stream-json event.
 * Returns null for any event that is not a streamed text delta.
 *
 * Shape (with `--include-partial-messages`):
 *   { type: "stream_event", event: { type: "content_block_delta",
 *       delta: { type: "text_delta", text: "..." } } }
 */
export function extractClaudeCodeDelta(json: unknown): string | null {
  const record = json as Record<string, unknown>;
  if (record.type !== "stream_event") return null;
  const event = record.event as Record<string, unknown> | undefined;
  if (event?.type !== "content_block_delta") return null;
  const delta = event.delta as Record<string, unknown> | undefined;
  if (delta?.type === "text_delta" && typeof delta.text === "string") {
    return delta.text;
  }
  return null;
}

/**
 * Parses the terminal `result` event into usage + cost. Returns null if the
 * event is not a result event.
 *
 * Shape: { type: "result", subtype, total_cost_usd, session_id, is_error,
 *          usage: { input_tokens, output_tokens, cache_* } }
 */
export function extractClaudeCodeResult(json: unknown): ClaudeCodeResultUsage | null {
  const record = json as Record<string, unknown>;
  if (record.type !== "result") return null;

  const usage = (record.usage as Record<string, unknown> | undefined) ?? {};
  const result: ClaudeCodeResultUsage = {
    inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
    outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
  };
  if (typeof usage.cache_creation_input_tokens === "number") {
    result.cacheCreationInputTokens = usage.cache_creation_input_tokens;
  }
  if (typeof usage.cache_read_input_tokens === "number") {
    result.cacheReadInputTokens = usage.cache_read_input_tokens;
  }
  if (typeof record.total_cost_usd === "number") {
    result.costUsd = record.total_cost_usd;
  }
  if (typeof record.session_id === "string") {
    result.sessionId = record.session_id;
  }
  const contextWindow = extractClaudeCodeContextWindow(record.modelUsage);
  if (contextWindow !== null) result.contextWindow = contextWindow;
  return result;
}

/**
 * The main model's `contextWindow` from the result's per-model `modelUsage`.
 * A turn can touch helper models alongside the main one, so "largest window"
 * is wrong (a bigger-windowed helper would win); the main model is the entry
 * that consumed the most prompt-side tokens. Entries without token counts fall
 * back to largest-window. Null when the CLI predates `modelUsage`.
 * Shared by the legacy stream-json parser and the SDK result mapper
 * ({@link ./sdk/sdkQueryEngine.resultUsage}), the payload shape is identical.
 */
export function extractClaudeCodeContextWindow(modelUsage: unknown): number | null {
  if (!modelUsage || typeof modelUsage !== "object") return null;

  const num = (value: unknown): number => (typeof value === "number" ? value : 0);
  let best: { window: number; traffic: number } | null = null;
  for (const raw of Object.values(modelUsage)) {
    const entry = raw as Record<string, unknown> | null;
    const window = entry?.contextWindow;
    if (typeof window !== "number") continue;
    const traffic =
      num(entry?.inputTokens) + num(entry?.cacheReadInputTokens) + num(entry?.cacheCreationInputTokens);
    if (
      !best ||
      traffic > best.traffic ||
      (traffic === best.traffic && window > best.window)
    ) {
      best = { window, traffic };
    }
  }
  return best?.window ?? null;
}

/**
 * Current context size from a top-level `assistant` event: the prompt tokens
 * (uncached + cache read + cache write) of that internal API call. Subagent
 * messages (`parent_tool_use_id` set) run in their own context and are ignored.
 * Returns null for anything else; callers keep the last non-null value, which
 * by the final event is {@link ClaudeCodeResultUsage.contextTokens}.
 */
export function extractClaudeCodeContextTokens(json: unknown): number | null {
  const record = json as Record<string, unknown>;
  if (record.type !== "assistant" || record.parent_tool_use_id) return null;
  const message = record.message as Record<string, unknown> | undefined;
  const usage = message?.usage as Record<string, unknown> | undefined;
  if (!usage) return null;

  const count = (value: unknown): number => (typeof value === "number" ? value : 0);
  const total =
    count(usage.input_tokens) +
    count(usage.cache_creation_input_tokens) +
    count(usage.cache_read_input_tokens);
  return total > 0 ? total : null;
}

/** Returns the error message from a `result` event with `is_error: true`, else null. */
export function extractClaudeCodeError(json: unknown): string | null {
  const record = json as Record<string, unknown>;
  if (record.type !== "result" || record.is_error !== true) return null;
  // The CLI puts a human-readable description in `result` on error subtypes.
  if (typeof record.result === "string" && record.result.length > 0) return record.result;
  if (typeof record.subtype === "string") return `Claude Code error: ${record.subtype}`;
  return "Claude Code reported an error.";
}

export async function* streamClaudeCode(
  opts: ClaudeCodeSpawnOptions,
): AsyncGenerator<string> {
  if (opts.signal?.aborted) throw createAbortError();

  const queue: string[] = [];
  let done = false;
  let error: Error | null = null;
  let wake: (() => void) | null = null;
  let child: ChildProcess | null = null;
  let stderrBuffer = "";

  const notify = () => {
    if (wake) {
      wake();
      wake = null;
    }
  };

  const abortHandler = () => {
    error = createAbortError();
    done = true;
    child?.kill();
    notify();
  };

  opts.signal?.addEventListener("abort", abortHandler, { once: true });

  try {
    child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      windowsHide: true,
      ...(opts.env ? { env: opts.env } : {}),
      // No shell: arguments are passed verbatim (avoids quoting issues with the
      // MCP-config JSON). The binary path is resolved by the caller.
    });

    child.on("error", (spawnError: NodeJS.ErrnoException) => {
      error = spawnError.code === "ENOENT"
        ? new ClaudeCodeNotFoundError(opts.command)
        : spawnError;
      done = true;
      notify();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    });

    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue; // Skip non-JSON noise.
        }

        opts.onEvent?.(parsed);

        const eventError = extractClaudeCodeError(parsed);
        if (eventError) {
          error = new Error(eventError);
          done = true;
          notify();
          return;
        }

        const delta = extractClaudeCodeDelta(parsed);
        if (delta) {
          queue.push(delta);
          notify();
        }
      }
    });

    child.on("close", (code: number | null) => {
      if (!error && code !== 0 && code !== null) {
        const detail = stderrBuffer.trim();
        error = new Error(
          `Claude Code exited with code ${code}.` + (detail ? ` ${detail.slice(0, 500)}` : ""),
        );
      }
      done = true;
      notify();
    });

    // Pipe the prompt and close stdin so the CLI starts processing.
    child.stdin?.end(opts.prompt);

    while (true) {
      if (queue.length > 0) {
        const token = queue.shift();
        if (token !== undefined) yield token;
      } else if (done) {
        break;
      } else {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    }
  } finally {
    opts.signal?.removeEventListener("abort", abortHandler);
    if (child && child.exitCode === null) child.kill();
  }

  if (error) throw error;
}

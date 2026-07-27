import { spawn } from "child_process";
import { existsSync } from "fs";
import { CLAUDE_HARD_DISPOSE_MS } from "../../constants";
import { ClaudeCodeNotFoundError } from "../claudeCodeProcess";
import type { SpawnedProcess, SpawnOptions } from "./claudeAgentSdk";

/**
 * Plugin ownership of the Agent SDK's CLI child (ADR-0032).
 *
 * PID-level measurements showed that the plugin had no bounded way to end an SDK
 * run: `iterator.return()` leaves the `claude` process alive, `abort()` alone
 * leaves it alive, and only `abort()` followed by draining the query to `done`
 * disposes it, at about seven seconds. That last one is the graceful path under a
 * different name, so when it is the thing that hung there is nothing to escalate
 * to. `SdkSession.dispose()` performs exactly the insufficient combination, which
 * is why idle eviction and unload could leak a live process whose MCP callbacks
 * still routed.
 *
 * `Options.spawnClaudeCodeProcess` is the SDK's own public seam for this. Supplying
 * it makes the plugin the owner of the child, which gives the SDK path the same
 * `kill()` primitive already verified at 25 ms for the legacy subprocess. The
 * escalation ladder becomes identical on both Claude paths.
 */
export class ClaudeCodeProcessOwner {
  private child: SpawnedProcess | null = null;
  private exited = false;
  private exitCode: number | null = null;

  /**
   * Pass as `Options.spawnClaudeCodeProcess`. The SDK calls it once per process it
   * would otherwise have spawned itself.
   *
   * The SDK's default implementation checks the executable exists before spawning;
   * replacing it means replicating that, otherwise a missing CLI surfaces as an
   * opaque stream failure instead of the plugin's own installation message. An
   * absolute path is checked directly; a bare command is left to `spawn` and its
   * ENOENT, since resolution is PATH's job.
   */
  readonly spawnProcess = (options: SpawnOptions): SpawnedProcess => {
    if (isPathLike(options.command) && !existsSync(options.command)) {
      throw new ClaudeCodeNotFoundError(options.command);
    }
    // The SDK's forwarded `signal` fires only after its own stdin-EOF plus grace
    // window, so handing it to `spawn` adds Node's kill *after* the CLI has had
    // its clean shutdown. Our own hardDispose is the immediate tier above it.
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      signal: options.signal,
    }) as unknown as SpawnedProcess;
    child.once("exit", (code) => {
      this.exited = true;
      this.exitCode = code;
    });
    // A spawn that fails to start never emits `exit`, so without this a
    // hardDispose would wait out its whole deadline on a process that was never
    // running.
    child.once("error", () => {
      this.exited = true;
    });
    this.child = child;
    return child;
  };

  /** True while a spawned child is known to be running. */
  get isRunning(): boolean {
    return this.child !== null && !this.exited;
  }

  /** Exit code once the child has exited, null before that. */
  get lastExitCode(): number | null {
    return this.exitCode;
  }

  /**
   * The verified hard dispose. Resolves once the child is gone, or rejects when
   * exit could not be proven within {@link CLAUDE_HARD_DISPOSE_MS}, which is what
   * turns a settlement `forced` rather than letting it claim proof it does not
   * have.
   */
  hardDispose(): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let timer: number | null = null;
      const done = (): void => {
        if (timer !== null) window.clearTimeout(timer);
        this.exited = true;
        resolve();
      };
      child.once("exit", done);
      timer = window.setTimeout(() => {
        child.off("exit", done);
        reject(
          new Error(
            `Claude Code process did not exit within ${CLAUDE_HARD_DISPOSE_MS}ms of kill`,
          ),
        );
      }, CLAUDE_HARD_DISPOSE_MS);
      try {
        // On win32 Node maps every signal to TerminateProcess, so SIGKILL is not
        // an escalation over SIGTERM, it is the same immediate operation. The
        // POSIX SIGTERM-then-SIGKILL ladder is a POSIX property and is not
        // reproduced here as if it were cross-platform behavior.
        child.kill("SIGKILL");
      } catch (error) {
        if (timer !== null) window.clearTimeout(timer);
        child.off("exit", done);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}

/** Whether a command string names a file to check rather than a PATH lookup. */
function isPathLike(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

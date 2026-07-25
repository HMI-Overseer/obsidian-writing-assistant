import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return { ...actual, spawn: spawnMock };
});

vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>(
    "child_process",
  );
  return { ...actual, spawn: spawnMock };
});

import { streamClaudeCode } from "../../../src/api/claudeCodeProcess";

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = { end: vi.fn() };
  exitCode: number | null = null;
  readonly kill = vi.fn(() => {
    this.exitCode = 0;
    this.emit("close", 0);
    return true;
  });
}

describe("legacy Claude Code process abort", () => {
  beforeEach(() => spawnMock.mockReset());

  it("kills the process, rejects with AbortError, and removes the signal listener", async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    const abortController = new AbortController();
    const addSpy = vi.spyOn(abortController.signal, "addEventListener");
    const removeSpy = vi.spyOn(abortController.signal, "removeEventListener");
    const iterator = streamClaudeCode({
      command: "claude",
      args: ["--print"],
      cwd: "D:\\vault",
      prompt: "Ask a question.",
      signal: abortController.signal,
    });

    const pending = iterator.next();
    abortController.abort();
    abortController.abort();

    await expect(pending).rejects.toMatchObject({
      name: "AbortError",
      message: "The request was aborted.",
    });
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.exitCode).not.toBeNull();
    const abortListener = addSpy.mock.calls[0]?.[1];
    expect(removeSpy).toHaveBeenCalledWith("abort", abortListener);
  });
});

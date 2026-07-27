import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_FIXTURE_BYTES,
  sanitizeCapture,
  validateFixture,
} from "../../../../scripts/captureFixtures.mjs";

const FIXTURE_DIR = join(
  process.cwd(),
  "tests",
  "fixtures",
  "provider-capture",
  "claude-code",
);
const MAX_TOTAL_BYTES = 256 * 1024;

function fixtureNames(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith(".json") && name !== "manifest.json")
    .sort();
}

describe("provider-capture fixtures", () => {
  it("cover every characterized protocol shape", () => {
    expect(fixtureNames()).toEqual([
      "legacy-cli-2.1.218-split-thinking-toolsearch.json",
      "sdk-0.3.207-cli-2.1.218-block-index-reuse-across-messages.json",
      "sdk-0.3.207-cli-2.1.218-completed-only-no-partials.json",
      "sdk-0.3.207-cli-2.1.218-conflicting-duplicate-delivery.json",
      "sdk-0.3.207-cli-2.1.218-cross-frame-duplicate-tool-id.json",
      "sdk-0.3.207-cli-2.1.218-duplicate-frame-delivery.json",
      "sdk-0.3.207-cli-2.1.218-intra-frame-duplicate-tool-id.json",
      "sdk-0.3.207-cli-2.1.218-lifecycle-before-declaration.json",
      "sdk-0.3.207-cli-2.1.218-malformed-tool-declaration.json",
      "sdk-0.3.207-cli-2.1.218-partial-only-no-completed.json",
      "sdk-0.3.207-cli-2.1.218-result-before-declaration.json",
      "sdk-0.3.207-cli-2.1.218-split-thinking-text.json",
      "sdk-0.3.207-cli-2.1.218-split-thinking-toolsearch.json",
      "sdk-0.3.207-cli-2.1.218-subagent-frames.json",
      "sdk-0.3.207-cli-2.1.218-supersedes-refusal-fallback.json",
      "sdk-0.3.207-cli-2.1.218-two-consecutive-tools.json",
    ]);
  });

  it("pass the allow-list validator and stay bounded", () => {
    let totalBytes = 0;
    for (const name of fixtureNames()) {
      const path = join(FIXTURE_DIR, name);
      totalBytes += statSync(path).size;
      const fixture: unknown = JSON.parse(readFileSync(path, "utf8"));
      expect(validateFixture(fixture, name)).toBeNull();
      expect(statSync(path).size, name).toBeLessThanOrEqual(MAX_FIXTURE_BYTES);
    }
    expect(totalBytes).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
  });

  it("pin every fixture to the installed SDK and CLI versions", () => {
    const manifest: { sdkVersion: string; cliVersion: string } = JSON.parse(
      readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf8"),
    );
    for (const name of fixtureNames()) {
      const fixture: { sdkVersion: string; cliVersion: string } = JSON.parse(
        readFileSync(join(FIXTURE_DIR, name), "utf8"),
      );
      expect(fixture.sdkVersion, name).toBe(manifest.sdkVersion);
      expect(fixture.cliVersion, name).toBe(manifest.cliVersion);
    }
  });
});

describe("capture sanitizer", () => {
  const rawFrame = {
    type: "assistant",
    uuid: "8f0a5b2e-real-wire-uuid",
    session_id: "b7c1-real-session",
    request_id: "req_real",
    parent_tool_use_id: null,
    timestamp: "2026-07-27T00:00:00.000Z",
    message: {
      id: "msg_real",
      role: "assistant",
      model: "claude-sonnet-4-5",
      stop_reason: null,
      content: [
        {
          type: "tool_use",
          id: "toolu_real",
          name: "Glob",
          input: { path: "C:\\Users\\Someone\\vault\\secret.md" },
        },
      ],
    },
  };

  it("drops keys the translator never reads", () => {
    const fixture = sanitizeCapture([rawFrame], meta());
    expect(fixture.frames[0]).not.toHaveProperty("timestamp");
  });

  it("replaces identity and content with deterministic aliases", () => {
    const first = sanitizeCapture([rawFrame], meta());
    const second = sanitizeCapture([rawFrame], meta());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("real");
    expect(serialized).not.toContain("Someone");
    expect(validateFixture(first, "sanitized")).toBeNull();
  });

  it("rejects a fixture carrying a non-allow-listed key", () => {
    const fixture = sanitizeCapture([rawFrame], meta());
    (fixture.frames[0] as Record<string, unknown>).cwd = "C:/vault";
    expect(validateFixture(fixture, "tampered")).toContain("not allow-listed");
  });

  it("rejects a fixture carrying an oversized string field", () => {
    const fixture = sanitizeCapture([rawFrame], meta());
    const block = (
      fixture.frames[0] as { message: { content: Array<Record<string, unknown>> } }
    ).message.content[0];
    block.name = "x".repeat(1024);
    expect(validateFixture(fixture, "tampered")).toContain("over the bound");
  });

  it("rejects a fixture carrying an absolute user path", () => {
    const fixture = sanitizeCapture([rawFrame], meta());
    fixture.description = "captured under C:\\Users\\Someone\\vault";
    expect(validateFixture(fixture, "tampered")).toContain("forbidden pattern");
  });
});

function meta(): Record<string, string> {
  return {
    case: "sanitizer-unit",
    transport: "sdk",
    sdkVersion: "0.3.207",
    cliVersion: "2.1.218",
    provenance: "captured",
    description: "Sanitizer unit input.",
  };
}

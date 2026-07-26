import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FIXTURE_DIR = join(process.cwd(), "tests", "fixtures", "assistant-turns");
const MAX_FIXTURE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;
const SECRET_OR_USER_PATH_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]+/,
  /sk-proj-[A-Za-z0-9_-]+/,
  /AKIA[0-9A-Z]{16}/,
  /Authorization["']?\s*:\s*["']?Bearer\s+/i,
  /[A-Za-z]:\\Users\\/,
  /\/Users\/[^/]+\//,
  /\/home\/[^/]+\//,
];

describe("assistant-turn provider fixtures", () => {
  it("are valid, bounded JSON without secrets or absolute user paths", () => {
    const fixtureNames = readdirSync(FIXTURE_DIR)
      .filter((name) => name.endsWith(".json"))
      .sort();

    expect(fixtureNames).toEqual([
      "anthropic-interleaved-blocks.json",
      "claude-code-legacy-stream-json-uncorrelated.json",
      "claude-code-sdk-consequential-unplaced.json",
      "claude-code-sdk-correlated.json",
      "claude-code-sdk-lifecycle-before-declaration.json",
      "legacy-conversations.json",
      "openai-compatible-interleaved-chunks.json",
    ]);

    let totalBytes = 0;
    for (const name of fixtureNames) {
      const path = join(FIXTURE_DIR, name);
      const size = statSync(path).size;
      const text = readFileSync(path, "utf8");

      totalBytes += size;
      expect(size, name).toBeLessThanOrEqual(MAX_FIXTURE_BYTES);
      expect(() => JSON.parse(text), name).not.toThrow();
      for (const pattern of SECRET_OR_USER_PATH_PATTERNS) {
        expect(text, `${name} matched ${pattern.source}`).not.toMatch(pattern);
      }
    }

    expect(totalBytes).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
  });
});

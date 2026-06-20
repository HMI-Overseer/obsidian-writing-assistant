import { describe, it, expect } from "vitest";
import {
  buildBenchmarkReport,
  buildHistoryEntry,
  buildReportFileName,
  formatTimestamp,
} from "../../../src/settings/benchmark/reportBuilder";
import type { SuiteReportSection } from "../../../src/settings/benchmark/reportBuilder";
import type { BenchmarkRunResult } from "../../../src/settings/benchmark/types";
import type { BenchmarkHistoryEntry, BenchmarkRunConditions } from "../../../src/shared/types";

const TIMESTAMP = new Date(2026, 5, 10, 14, 30).getTime();

function makeConditions(overrides: Partial<BenchmarkRunConditions> = {}): BenchmarkRunConditions {
  return {
    provider: "lmstudio",
    modelId: "qwen2.5-14b-instruct",
    modelName: "Qwen 2.5 14B",
    profileName: "Default",
    samplingParams: {
      temperature: 0.7,
      maxTokens: null,
      topP: null,
      topK: null,
      minP: null,
      repeatPenalty: null,
      reasoning: null,
    },
    pluginVersion: "1.1.0",
    timestamp: TIMESTAMP,
    iterationCount: 3,
    ...overrides,
  };
}

function makeResult(testId: string, passCount: number, totalCount: number, error?: string): BenchmarkRunResult {
  return {
    testId,
    testName: `Test ${testId}`,
    modelId: "qwen2.5-14b-instruct",
    iterations: Array.from({ length: totalCount }, (_, i) => ({
      iteration: i + 1,
      result: {
        passed: i < passCount,
        reason: i < passCount ? "ok" : "missed the target paragraph",
        evidence: [],
      },
      rawResponse: "",
      durationMs: 1000,
    })),
    passCount,
    totalCount,
    avgDurationMs: 1000,
    error,
  };
}

function makeSections(): SuiteReportSection[] {
  return [
    {
      suiteId: "edit-annotations",
      suiteName: "Edit annotations",
      results: [
        { result: makeResult("t1", 3, 3), isControl: false },
        { result: makeResult("t2", 1, 3), isControl: false },
        { result: makeResult("control", 3, 3), isControl: true },
      ],
    },
  ];
}

describe("formatTimestamp", () => {
  it("formats local date and time", () => {
    expect(formatTimestamp(TIMESTAMP)).toBe("2026-06-10 14:30");
  });
});

describe("buildHistoryEntry", () => {
  it("condenses results without raw responses", () => {
    const entry = buildHistoryEntry(makeConditions(), makeSections());

    expect(entry.results).toHaveLength(3);
    expect(entry.results[0]).toEqual({
      testId: "t1",
      testName: "Test t1",
      suiteId: "edit-annotations",
      passCount: 3,
      totalCount: 3,
      avgDurationMs: 1000,
      isControl: false,
    });
    expect(entry.results[2].isControl).toBe(true);
    expect(JSON.stringify(entry)).not.toContain("rawResponse");
  });

  it("records test errors", () => {
    const sections: SuiteReportSection[] = [
      {
        suiteId: "s",
        suiteName: "S",
        results: [{ result: makeResult("t1", 0, 0, "connection refused"), isControl: false }],
      },
    ];
    const entry = buildHistoryEntry(makeConditions(), sections);
    expect(entry.results[0].error).toBe("connection refused");
  });
});

describe("buildReportFileName", () => {
  it("includes model name and timestamp", () => {
    const name = buildReportFileName(makeConditions());
    expect(name).toBe("Benchmark Qwen 2.5 14B 2026-06-10 14.30");
  });

  it("strips characters invalid in file names and wikilinks", () => {
    const name = buildReportFileName(makeConditions({ modelName: 'mistral:7b [v2] "best"' }));
    expect(name).not.toMatch(/[\\/:*?"<>|#^[\]]/);
  });
});

describe("buildBenchmarkReport", () => {
  it("includes run conditions", () => {
    const report = buildBenchmarkReport(makeConditions(), makeSections(), []);

    expect(report).toContain("# Benchmark report, Qwen 2.5 14B");
    expect(report).toContain("| Provider | lmstudio |");
    expect(report).toContain("| Model | qwen2.5-14b-instruct |");
    expect(report).toContain("| Profile | Default |");
    expect(report).toContain("temperature 0.7");
    expect(report).toContain("| Iterations per test | 3 |");
    expect(report).toContain("| Plugin version | 1.1.0 |");
  });

  it("excludes control tests from the overall score", () => {
    const report = buildBenchmarkReport(makeConditions(), makeSections(), []);
    // 4/6 from t1+t2; the control's 3/3 must not count.
    expect(report).toContain("**Overall score: 4/6 (67%)**");
  });

  it("renders a result row per test and marks controls", () => {
    const report = buildBenchmarkReport(makeConditions(), makeSections(), []);
    expect(report).toContain("| Test t1 | 3/3 | 1.0s |");
    expect(report).toContain("| Test control *(control)* | 3/3 |");
  });

  it("lists failed iterations with reasons", () => {
    const report = buildBenchmarkReport(makeConditions(), makeSections(), []);
    expect(report).toContain("### Failed iterations");
    expect(report).toContain("**Test t2** (iteration 2): missed the target paragraph");
  });

  it("shows test errors in the notes column", () => {
    const sections: SuiteReportSection[] = [
      {
        suiteId: "s",
        suiteName: "S",
        results: [{ result: makeResult("t1", 0, 0, "connection refused"), isControl: false }],
      },
    ];
    const report = buildBenchmarkReport(makeConditions(), sections, []);
    expect(report).toContain("Error: connection refused");
  });

  it("renders previous runs but not the current one", () => {
    const current = makeConditions();
    const previousEntry: BenchmarkHistoryEntry = buildHistoryEntry(
      makeConditions({ modelName: "Llama 3 8B", timestamp: TIMESTAMP - 86_400_000 }),
      makeSections(),
    );
    const currentEntry = buildHistoryEntry(current, makeSections());

    const report = buildBenchmarkReport(current, makeSections(), [currentEntry, previousEntry]);

    expect(report).toContain("## Previous runs");
    expect(report).toContain("| Llama 3 8B |");
    // Current run appears once as the title, not again in the history table.
    expect(report.match(/Qwen 2\.5 14B/g)).toHaveLength(1);
  });

  it("omits the previous runs section when history is empty", () => {
    const report = buildBenchmarkReport(makeConditions(), makeSections(), []);
    expect(report).not.toContain("## Previous runs");
  });

  it("escapes pipe characters in table cells", () => {
    const conditions = makeConditions({ profileName: "a|b" });
    const report = buildBenchmarkReport(conditions, makeSections(), []);
    expect(report).toContain("a\\|b");
  });

  it("reports the average iteration duration", () => {
    const report = buildBenchmarkReport(makeConditions(), makeSections(), []);
    expect(report).toContain("**Average iteration duration: 1.0s**");
  });

  it("omits the slow-responses warning for fast runs", () => {
    const report = buildBenchmarkReport(makeConditions(), makeSections(), []);
    expect(report).not.toContain("[!warning] Slow responses");
  });

  it("adds a slow-responses callout and per-test notes for slow runs", () => {
    const slowResult = { ...makeResult("t1", 3, 3), avgDurationMs: 25_000 };
    const sections: SuiteReportSection[] = [
      { suiteId: "s", suiteName: "S", results: [{ result: slowResult, isControl: false }] },
    ];
    const report = buildBenchmarkReport(makeConditions(), sections, []);

    expect(report).toContain("[!warning] Slow responses");
    expect(report).toContain("consider a smaller model or a lower-bit quantization");
    expect(report).toContain("| Test t1 | 3/3 | 25.0s | Slow |");
  });

  it("includes an average iteration column in previous runs", () => {
    const previousEntry = buildHistoryEntry(
      makeConditions({ modelName: "Llama 3 8B", timestamp: TIMESTAMP - 86_400_000 }),
      makeSections(),
    );
    const report = buildBenchmarkReport(makeConditions(), makeSections(), [previousEntry]);

    expect(report).toContain("| Date | Model | Profile | Sampling | Score | Avg iteration |");
    expect(report).toMatch(/\| Llama 3 8B \|.*\| 1\.0s \|/);
  });
});

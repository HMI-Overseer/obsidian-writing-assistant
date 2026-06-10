import type {
  BenchmarkHistoryEntry,
  BenchmarkHistoryTestResult,
  BenchmarkRunConditions,
} from "../../shared/types";
import type { BenchmarkRunResult } from "./types";

/** One suite's worth of results, paired with control flags, ready for reporting. */
export interface SuiteReportSection {
  suiteId: string;
  suiteName: string;
  results: { result: BenchmarkRunResult; isControl: boolean }[];
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Characters Obsidian forbids or mangles in file names and wikilinks. */
const UNSAFE_FILENAME_CHARS = /[\\/:*?"<>|#^[\]]/g;

function sanitizeFileName(name: string): string {
  return name.replace(UNSAFE_FILENAME_CHARS, "-").replace(/\s+/g, " ").trim();
}

/** Formats epoch ms as a local "YYYY-MM-DD HH:mm" string. */
export function formatTimestamp(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Escapes a value for use inside a markdown table cell. */
function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatSamplingParams(conditions: BenchmarkRunConditions): string {
  const p = conditions.samplingParams;
  const parts = [`temperature ${p.temperature}`];
  if (p.maxTokens !== null) parts.push(`max tokens ${p.maxTokens}`);
  if (p.topP !== null) parts.push(`top-p ${p.topP}`);
  if (p.topK !== null) parts.push(`top-k ${p.topK}`);
  if (p.minP !== null) parts.push(`min-p ${p.minP}`);
  if (p.repeatPenalty !== null) parts.push(`repeat penalty ${p.repeatPenalty}`);
  if (p.reasoning !== null) parts.push(`reasoning ${p.reasoning}`);
  return parts.join(", ");
}

interface ScoreTally {
  passed: number;
  total: number;
}

/** Iteration pass rate across non-control results. */
function tallyScore(results: { passCount: number; totalCount: number; isControl: boolean }[]): ScoreTally {
  let passed = 0;
  let total = 0;
  for (const r of results) {
    if (r.isControl) continue;
    passed += r.passCount;
    total += r.totalCount;
  }
  return { passed, total };
}

function formatScore(score: ScoreTally): string {
  if (score.total === 0) return "—";
  const pct = Math.round((score.passed / score.total) * 100);
  return `${score.passed}/${score.total} (${pct}%)`;
}

// ---------------------------------------------------------------------------
// History entry
// ---------------------------------------------------------------------------

/** Condenses a run into a persistable history entry. Raw responses are dropped. */
export function buildHistoryEntry(
  conditions: BenchmarkRunConditions,
  sections: SuiteReportSection[],
): BenchmarkHistoryEntry {
  const results: BenchmarkHistoryTestResult[] = sections.flatMap((section) =>
    section.results.map(({ result, isControl }) => ({
      testId: result.testId,
      testName: result.testName,
      suiteId: section.suiteId,
      passCount: result.passCount,
      totalCount: result.totalCount,
      avgDurationMs: result.avgDurationMs,
      isControl,
      ...(result.error !== undefined ? { error: result.error } : {}),
    }))
  );

  return {
    id: `${conditions.timestamp}-${conditions.modelId}`,
    conditions,
    results,
  };
}

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------

/** Builds the suggested report file name (without extension or folder). */
export function buildReportFileName(conditions: BenchmarkRunConditions): string {
  const stamp = formatTimestamp(conditions.timestamp).replace(":", ".");
  return sanitizeFileName(`Benchmark ${conditions.modelName} ${stamp}`);
}

/**
 * Renders a full benchmark report as markdown: run conditions, per-suite
 * result tables, failure details, and a comparison table of previous runs.
 */
export function buildBenchmarkReport(
  conditions: BenchmarkRunConditions,
  sections: SuiteReportSection[],
  history: BenchmarkHistoryEntry[],
): string {
  const lines: string[] = [];

  lines.push(`# Benchmark report — ${conditions.modelName}`);
  lines.push("");

  // --- Run conditions ---
  lines.push("## Run conditions");
  lines.push("");
  lines.push("| Setting | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Date | ${formatTimestamp(conditions.timestamp)} |`);
  lines.push(`| Provider | ${cell(conditions.provider)} |`);
  lines.push(`| Model | ${cell(conditions.modelId)} |`);
  lines.push(`| Profile | ${cell(conditions.profileName)} |`);
  lines.push(`| Sampling | ${cell(formatSamplingParams(conditions))} |`);
  lines.push(`| Iterations per test | ${conditions.iterationCount} |`);
  lines.push(`| Plugin version | ${cell(conditions.pluginVersion)} |`);
  lines.push("");

  // --- Overall score ---
  const allResults = sections.flatMap((s) =>
    s.results.map(({ result, isControl }) => ({ ...result, isControl }))
  );
  lines.push(`**Overall score: ${formatScore(tallyScore(allResults))}** (iterations passed, control tests excluded)`);
  lines.push("");

  // --- Per-suite results ---
  for (const section of sections) {
    if (section.results.length === 0) continue;

    lines.push(`## ${section.suiteName}`);
    lines.push("");
    lines.push("| Test | Passed | Avg duration | Notes |");
    lines.push("| --- | --- | --- | --- |");

    for (const { result, isControl } of section.results) {
      const name = isControl ? `${result.testName} *(control)*` : result.testName;
      const passed = result.totalCount > 0 ? `${result.passCount}/${result.totalCount}` : "—";
      const duration = result.totalCount > 0 ? formatSeconds(result.avgDurationMs) : "—";
      const notes = result.error ? `Error: ${result.error}` : "";
      lines.push(`| ${cell(name)} | ${passed} | ${duration} | ${cell(notes)} |`);
    }
    lines.push("");

    const failures = section.results.flatMap(({ result, isControl }) =>
      isControl
        ? []
        : result.iterations
            .filter((it) => !it.result.passed)
            .map((it) => ({ testName: result.testName, iteration: it.iteration, reason: it.result.reason }))
    );

    if (failures.length > 0) {
      lines.push("### Failed iterations");
      lines.push("");
      for (const f of failures) {
        lines.push(`- **${f.testName}** (iteration ${f.iteration}): ${f.reason}`);
      }
      lines.push("");
    }
  }

  // --- Previous runs ---
  const previous = history.filter((entry) => entry.conditions.timestamp !== conditions.timestamp);
  if (previous.length > 0) {
    lines.push("## Previous runs");
    lines.push("");
    lines.push("| Date | Model | Profile | Sampling | Score |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const entry of previous) {
      const score = formatScore(tallyScore(entry.results));
      lines.push(
        `| ${formatTimestamp(entry.conditions.timestamp)} ` +
        `| ${cell(entry.conditions.modelName)} ` +
        `| ${cell(entry.conditions.profileName)} ` +
        `| ${cell(formatSamplingParams(entry.conditions))} ` +
        `| ${score} |`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

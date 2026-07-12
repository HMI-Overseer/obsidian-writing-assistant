import type { LabRunResult, LabTrialTrace } from "./types";

function tableCell(value: string | number | boolean | null | undefined): string {
  if (value === undefined || value === null || value === "") return "Not recorded";
  return String(value).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function trialStatus(trace: LabTrialTrace): string {
  return trace.passed ? "Passed" : "Failed";
}

function stopReason(trace: LabTrialTrace): string {
  return trace.outcome.kind === "completion"
    ? trace.outcome.response.stopReason ?? "Not reported"
    : trace.outcome.error.timedOut
      ? "Timeout"
      : "Error";
}

function inputTokens(trace: LabTrialTrace): number | null {
  return trace.outcome.kind === "completion"
    ? trace.outcome.response.usage?.inputTokens ?? null
    : null;
}

function outputTokens(trace: LabTrialTrace): number | null {
  return trace.outcome.kind === "completion"
    ? trace.outcome.response.usage?.outputTokens ?? null
    : null;
}

export function buildLabMarkdownReport(result: LabRunResult): string {
  const { manifest } = result;
  const subject = manifest.provenance.subject;
  const lines: string[] = [
    `# Laboratory run: ${manifest.scenario.title}`,
    "",
    `**Result: ${result.passCount}/${result.totalCount} trials passed**`,
    "",
    "## Run identity",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Run ID | ${tableCell(result.runId)} |`,
    `| Started | ${tableCell(manifest.startedAt)} |`,
    `| Completed | ${tableCell(result.completedAt)} |`,
    `| Scenario | ${tableCell(`${manifest.scenario.id} v${manifest.scenario.version}`)} |`,
    `| Provider | ${tableCell(subject.provider)} |`,
    `| Model | ${tableCell(subject.modelId)} |`,
    `| Endpoint | ${tableCell(subject.endpoint)} |`,
    `| Source revision | ${tableCell(manifest.provenance.sourceRevision)} |`,
    `| Iterations | ${manifest.conditions.iterations} |`,
    `| Timeout per trial | ${manifest.conditions.timeoutMs} ms |`,
    "",
    "## Sampling",
    "",
    "| Parameter | Value |",
    "| --- | --- |",
  ];

  for (const [key, value] of Object.entries(manifest.conditions.samplingParams)) {
    lines.push(`| ${tableCell(key)} | ${tableCell(value)} |`);
  }

  const runtime = subject.runtime ?? {};
  lines.push("", "## Subject metadata", "", "| Field | Value |", "| --- | --- |");
  if (Object.keys(runtime).length === 0) {
    lines.push("| Metadata | Not recorded |");
  } else {
    for (const key of Object.keys(runtime).sort()) {
      lines.push(`| ${tableCell(key)} | ${tableCell(runtime[key])} |`);
    }
  }

  lines.push(
    "",
    "## Trials",
    "",
    "| Trial | Status | Duration | Stop | Input tokens | Output tokens |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  for (const trace of result.traces) {
    lines.push(
      `| ${trace.trial} | ${trialStatus(trace)} | ${trace.durationMs} ms | ` +
      `${tableCell(stopReason(trace))} | ${tableCell(inputTokens(trace))} | ` +
      `${tableCell(outputTokens(trace))} |`,
    );
  }

  const failed = result.traces.filter((trace) => !trace.passed);
  if (failed.length > 0) {
    lines.push("", "## Failure details", "");
    for (const trace of failed) {
      lines.push(`### Trial ${trace.trial}`, "");
      if (trace.outcome.kind === "error") {
        lines.push(`- Completion error: ${trace.outcome.error.name}: ${trace.outcome.error.message}`);
      }
      for (const check of trace.checks.filter((entry) => entry.required && !entry.passed)) {
        lines.push(`- ${check.label}${check.detail ? `: ${check.detail}` : ""}`);
      }
      lines.push("");
    }
  }

  lines.push(
    "",
    "## Evidence",
    "",
    "The JSON manifest, individual trial traces, and summary in this run directory are the canonical evidence. This report is a derived view.",
    "",
  );
  return lines.join("\n");
}

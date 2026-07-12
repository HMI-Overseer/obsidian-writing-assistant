import type { SandboxEpisodeRunResult, SandboxEpisodeTrace } from "./types";

function cell(value: string | number | boolean | null | undefined): string {
  if (value === undefined || value === null || value === "") return "Not recorded";
  return String(value).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

export function buildSandboxEpisodeReport(trace: SandboxEpisodeTrace): string {
  const subject = trace.provenance.subject;
  const lines: string[] = [
    `# Sandbox episode: ${trace.scenario.title}`,
    "",
    `**Result: ${trace.passed ? "Passed" : "Failed"}**`,
    "",
    "## Episode identity",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Episode ID | ${cell(trace.episodeId)} |`,
    `| Scenario | ${cell(`${trace.scenario.id} v${trace.scenario.version}`)} |`,
    `| Fixture | ${cell(`${trace.fixture.id} v${trace.fixture.version}`)} |`,
    `| Outcome | ${cell(trace.outcome.kind)} |`,
    `| Provider | ${cell(subject.provider)} |`,
    `| Model | ${cell(subject.modelId)} |`,
    `| Endpoint | ${cell(subject.endpoint)} |`,
    `| Source revision | ${cell(trace.provenance.sourceRevision)} |`,
    `| Maximum rounds | ${trace.conditions.maxRounds} |`,
    `| Maximum tool calls | ${trace.conditions.maxToolCalls} |`,
    `| Maximum repeated tool calls | ${trace.conditions.maxRepeatedToolCalls} |`,
    `| Maximum total tokens | ${trace.conditions.maxTotalTokens} |`,
    `| Maximum output characters | ${trace.conditions.maxOutputChars} |`,
    `| Response normalization | ${trace.conditions.responseNormalization
      ? cell(`${trace.conditions.responseNormalization.id} v${trace.conditions.responseNormalization.version}`)
      : "None"} |`,
    `| Compatibility policy | ${trace.conditions.compatibilityPolicy
      ? cell(`${trace.conditions.compatibilityPolicy.id} v${trace.conditions.compatibilityPolicy.version}`)
      : "None"} |`,
    `| Policy match | ${trace.conditions.compatibilityPolicy
      ? cell(`${trace.conditions.compatibilityPolicy.matchedBy.kind}: ${trace.conditions.compatibilityPolicy.matchedBy.value}`)
      : "Not applicable"} |`,
    `| Write review | ${trace.conditions.writeReview
      ? cell(`${trace.conditions.writeReview.disposition}: ${trace.conditions.writeReview.reason}`)
      : "None"} |`,
    "",
    "## Checks",
    "",
    "| Check | Required | Result | Detail |",
    "| --- | --- | --- | --- |",
  ];

  for (const check of trace.checks) {
    lines.push(
      `| ${cell(check.label)} | ${check.required ? "Yes" : "No"} | ` +
      `${check.passed ? "Passed" : "Failed"} | ${cell(check.detail)} |`,
    );
  }

  lines.push(
    "",
    "## Rounds",
    "",
    "| Round | Duration | Stop reason | Tool calls | Input tokens | Output tokens | Normalized |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const round of trace.rounds) {
    lines.push(
      `| ${round.round} | ${round.durationMs} ms | ${cell(round.response.stopReason)} | ` +
      `${round.toolExecutions.length} | ${cell(round.response.usage?.inputTokens)} | ` +
      `${cell(round.response.usage?.outputTokens)} | ${round.normalization.changed ? "Yes" : "No"} |`,
    );
  }

  const executions = trace.rounds.flatMap((round) => round.toolExecutions);
  lines.push("", "## Tool executions", "");
  if (executions.length === 0) {
    lines.push("No sandbox tools were executed.", "");
  } else {
    for (const execution of executions) {
      lines.push(
        `### ${execution.call.name}`,
        "",
        `- Call ID: ${execution.call.id}`,
        `- Arguments: \`${JSON.stringify(execution.call.arguments)}\``,
        `- Result: ${execution.result.isError ? "Error" : "Success"}`,
        `- Review disposition: ${execution.review?.disposition ?? "Not applicable"}`,
        `- State unchanged: ${JSON.stringify(execution.snapshotBefore) === JSON.stringify(execution.snapshotAfter) ? "Yes" : "No"}`,
        "",
      );
    }
  }

  lines.push(
    "## State diff",
    "",
    `- Created: ${trace.stateDiff.created.map((file) => file.path).join(", ") || "None"}`,
    `- Modified: ${trace.stateDiff.modified.map((file) => file.after.path).join(", ") || "None"}`,
    `- Deleted: ${trace.stateDiff.deleted.map((file) => file.path).join(", ") || "None"}`,
    "",
  );

  const normalizedRounds = trace.rounds.filter((round) => round.normalization.changed);
  lines.push("", "## Response normalization", "");
  if (normalizedRounds.length === 0) {
    lines.push("No response text was changed.", "");
  } else {
    for (const round of normalizedRounds) {
      lines.push(
        `### Round ${round.round}`,
        "",
        "Raw provider text:",
        "",
        "```text",
        round.rawResponse.text,
        "```",
        "",
        "Normalized text:",
        "",
        "```text",
        round.response.text,
        "```",
        "",
      );
    }
  }

  lines.push(
    "## Final answer",
    "",
    trace.finalText || "No final answer was produced.",
    "",
    "## Evidence",
    "",
    "`episode.json` is the canonical episode trace. This report is a derived view.",
    "",
  );
  return lines.join("\n");
}

export function buildSandboxEpisodeRunReport(result: SandboxEpisodeRunResult): string {
  const { manifest, summary } = result;
  const subject = manifest.provenance.subject;
  const lines: string[] = [
    `# Sandbox episode run: ${manifest.scenario.title}`,
    "",
    `**Result: ${summary.passCount}/${summary.completedCount} episodes passed**`,
    "",
    "## Run identity",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Run ID | ${cell(result.runId)} |`,
    `| Scenario | ${cell(`${manifest.scenario.id} v${manifest.scenario.version}`)} |`,
    `| Fixture | ${cell(`${manifest.fixture.id} v${manifest.fixture.version}`)} |`,
    `| Provider | ${cell(subject.provider)} |`,
    `| Model | ${cell(subject.modelId)} |`,
    `| Source revision | ${cell(manifest.provenance.sourceRevision)} |`,
    `| Requested repetitions | ${manifest.conditions.iterations} |`,
    `| Completed repetitions | ${summary.completedCount} |`,
    `| Timeout per episode | ${manifest.conditions.timeoutMs} ms |`,
    `| Maximum rounds | ${manifest.conditions.maxRounds} |`,
    `| Maximum tool calls | ${manifest.conditions.maxToolCalls} |`,
    `| Maximum repeated tool calls | ${manifest.conditions.maxRepeatedToolCalls} |`,
    `| Maximum total tokens | ${manifest.conditions.maxTotalTokens} |`,
    `| Maximum output characters | ${manifest.conditions.maxOutputChars} |`,
    `| Response normalization | ${manifest.conditions.responseNormalization
      ? cell(`${manifest.conditions.responseNormalization.id} v${manifest.conditions.responseNormalization.version}`)
      : "None"} |`,
    `| Compatibility policy | ${manifest.conditions.compatibilityPolicy
      ? cell(`${manifest.conditions.compatibilityPolicy.id} v${manifest.conditions.compatibilityPolicy.version}`)
      : "None"} |`,
    `| Policy match | ${manifest.conditions.compatibilityPolicy
      ? cell(`${manifest.conditions.compatibilityPolicy.matchedBy.kind}: ${manifest.conditions.compatibilityPolicy.matchedBy.value}`)
      : "Not applicable"} |`,
    `| Write review | ${manifest.conditions.writeReview
      ? cell(`${manifest.conditions.writeReview.disposition}: ${manifest.conditions.writeReview.reason}`)
      : "None"} |`,
    "",
    "## Aggregate observations",
    "",
    "| Measure | Value |",
    "| --- | --- |",
    `| Passed | ${summary.passCount}/${summary.completedCount} |`,
    `| Episodes with normalization | ${summary.normalization.episodeCount} |`,
    `| Normalized rounds | ${summary.normalization.roundCount} |`,
    `| Episodes with exact raw leakage | ${summary.rawLeakage.episodeCount} |`,
    `| Raw leakage rounds | ${summary.rawLeakage.roundCount} |`,
    `| Total duration | ${summary.timingMs.total} ms |`,
    `| Mean duration | ${cell(summary.timingMs.mean)} ms |`,
    `| Total tool calls | ${summary.toolCalls.total} |`,
    `| Total input tokens | ${summary.usage.inputTokens} |`,
    `| Total output tokens | ${summary.usage.outputTokens} |`,
    "",
    "## Episodes",
    "",
    "| Iteration | Episode ID | Result | Outcome | Duration | Tool calls | Input tokens | Output tokens | Normalized rounds | Raw leakage rounds | Failed checks |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const episode of summary.episodes) {
    lines.push(
      `| ${episode.iteration} | ${cell(episode.episodeId)} | ` +
      `${episode.passed ? "Passed" : "Failed"} | ${cell(episode.outcome)} | ` +
      `${episode.durationMs} ms | ${episode.toolCalls} | ${cell(episode.inputTokens)} | ` +
      `${cell(episode.outputTokens)} | ${episode.normalizedRounds} | ` +
      `${episode.rawLeakageRounds} | ` +
      `${cell(episode.failedChecks.map((check) => check.label).join("; ") || "None")} |`,
    );
  }

  const failed = summary.episodes.filter((episode) => episode.failedChecks.length > 0);
  if (failed.length > 0) {
    lines.push("", "## Failure details", "");
    for (const episode of failed) {
      lines.push(`### Iteration ${episode.iteration}`, "");
      for (const check of episode.failedChecks) {
        lines.push(`- ${check.label}${check.detail ? `: ${check.detail}` : ""}`);
      }
      lines.push("");
    }
  }

  lines.push(
    "",
    "## Interpretation limit",
    "",
    "These repetitions are descriptive evidence. Stability and latency claims require a separately justified sample size and comparison design.",
    "",
    "## Evidence",
    "",
    "Each `episodes/<episode-id>/episode.json` file is a canonical self-contained trace. `summary.json` and this report are derived views and do not replace or mutate those traces.",
    "",
  );
  return lines.join("\n");
}

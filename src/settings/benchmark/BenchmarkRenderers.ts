import type {
  BenchmarkMessage,
  BenchmarkRunResult,
  EvaluationCriteria,
} from "./types";
import type { SummaryStats, SuiteSummaryStats } from "./BenchmarkSummary";

// ---------------------------------------------------------------------------
// Static detail renderers
// ---------------------------------------------------------------------------

export function renderCriteria(container: HTMLElement, criteria: EvaluationCriteria): void {
  const wrapper = container.createDiv({ cls: "lmsa-benchmark-criteria" });
  wrapper.createDiv({ cls: "lmsa-benchmark-section-header" })
    .createEl("strong", { text: "Evaluation criteria" });

  const expectedEl = wrapper.createDiv({ cls: "lmsa-benchmark-criteria-row" });
  expectedEl.createEl("strong", { text: "Expected: " });
  expectedEl.createSpan({ text: criteria.expectedOutcome });

  if (criteria.targetKeywords?.length) {
    const targetEl = wrapper.createDiv({ cls: "lmsa-benchmark-criteria-row" });
    targetEl.createEl("strong", { text: `Must target (${criteria.targetLabel ?? "target"}): ` });
    targetEl.createSpan({ text: criteria.targetKeywords.join(", ") });
  }

  if (criteria.forbiddenKeywords?.length) {
    const forbidEl = wrapper.createDiv({ cls: "lmsa-benchmark-criteria-row" });
    forbidEl.createEl("strong", { text: `Must avoid (${criteria.forbiddenLabel ?? "forbidden"}): ` });
    forbidEl.createSpan({ text: criteria.forbiddenKeywords.join(", ") });
  }

  if (criteria.requiredMentions?.length) {
    const mentionsEl = wrapper.createDiv({ cls: "lmsa-benchmark-criteria-row" });
    mentionsEl.createEl("strong", { text: "Response must mention: " });
    mentionsEl.createSpan({ text: criteria.requiredMentions.join(", ") });
  }

  if (criteria.notes) {
    const notesEl = wrapper.createDiv({ cls: "lmsa-benchmark-criteria-row lmsa-benchmark-criteria-notes" });
    notesEl.createEl("em", { text: criteria.notes });
  }
}

export function renderConversationPreview(container: HTMLElement, messages: BenchmarkMessage[]): void {
  const wrapper = container.createDiv({ cls: "lmsa-benchmark-conversation" });
  wrapper.createDiv({ cls: "lmsa-benchmark-section-header" })
    .createEl("strong", { text: `Conversation (${messages.length} messages)` });

  for (const msg of messages) {
    const msgEl = wrapper.createDiv({ cls: "lmsa-benchmark-msg" });
    msgEl.createSpan({
      cls: `lmsa-benchmark-msg-role lmsa-benchmark-msg-role--${msg.role}`,
      text: msg.role,
    });

    const contentText = msg.content;
    if (contentText.length > 200) {
      const preview = msgEl.createSpan({ cls: "lmsa-benchmark-msg-content" });
      preview.setText(contentText.slice(0, 200) + "...");
      const fullContent = msgEl.createDiv({ cls: "lmsa-benchmark-msg-full lmsa-hidden" });
      fullContent.createEl("pre", {
        cls: "lmsa-benchmark-response-block",
        text: contentText,
      });
      const showBtn = msgEl.createEl("button", {
        cls: "lmsa-benchmark-btn lmsa-benchmark-btn--inline",
        text: "Show full",
      });
      showBtn.addEventListener("click", () => {
        const hidden = fullContent.hasClass("lmsa-hidden");
        fullContent.toggleClass("lmsa-hidden", !hidden);
        preview.toggleClass("lmsa-hidden", hidden);
        showBtn.setText(hidden ? "Show less" : "Show full");
      });
    } else {
      msgEl.createSpan({ cls: "lmsa-benchmark-msg-content", text: contentText });
    }
  }
}

// ---------------------------------------------------------------------------
// Results renderer (per-card, after run)
// ---------------------------------------------------------------------------

export function renderCardResults(
  resultsContainerEl: HTMLElement,
  result: BenchmarkRunResult,
): void {
  resultsContainerEl.empty();
  resultsContainerEl.createDiv({ cls: "lmsa-benchmark-section-header" })
    .createEl("strong", { text: "Results" });

  for (const iter of result.iterations) {
    const iterEl = resultsContainerEl.createDiv({ cls: "lmsa-benchmark-iteration" });

    const iterHeader = iterEl.createDiv({ cls: "lmsa-benchmark-iteration-header" });
    const iterLabel = iterHeader.createSpan({ cls: "lmsa-benchmark-iteration-label" });
    iterLabel.setText(`Iteration ${iter.iteration}`);

    const iterStatus = iterHeader.createSpan({
      cls: `lmsa-benchmark-iteration-status ${iter.result.passed ? "is-passed" : "is-failed"}`,
    });
    iterStatus.setText(`${iter.result.passed ? "Passed" : "Failed"} (${(iter.durationMs / 1000).toFixed(1)}s)`);

    const reasonEl = iterEl.createDiv({ cls: "lmsa-benchmark-detail-section" });
    reasonEl.createEl("strong", { text: "Evaluation: " });
    reasonEl.createSpan({ text: iter.result.reason });

    if (iter.result.evidence.length > 0) {
      const evidenceEl = iterEl.createDiv({ cls: "lmsa-benchmark-detail-section" });
      evidenceEl.createEl("strong", { text: "Evidence:" });
      const list = evidenceEl.createEl("ul", { cls: "lmsa-benchmark-evidence-list" });
      for (const e of iter.result.evidence) {
        list.createEl("li", { text: e });
      }
    }

    if (iter.toolCalls && iter.toolCalls.length > 0) {
      const toolsEl = iterEl.createDiv({ cls: "lmsa-benchmark-detail-section" });
      toolsEl.createEl("strong", { text: `Tool calls (${iter.toolCalls.length}):` });
      const toolsList = toolsEl.createEl("ul", { cls: "lmsa-benchmark-evidence-list" });
      for (const tc of iter.toolCalls) {
        const argsStr = JSON.stringify(tc.arguments, null, 2);
        const preview = argsStr.length > 150 ? argsStr.slice(0, 150) + "..." : argsStr;
        toolsList.createEl("li", { text: `${tc.name}(${preview})` });
      }
    }

    const responseEl = iterEl.createDiv({ cls: "lmsa-benchmark-detail-section" });
    responseEl.createEl("strong", { text: "Model response:" });
    responseEl.createEl("pre", {
      cls: "lmsa-benchmark-response-block",
      text: iter.rawResponse || "(no text content — tool calls only)",
    });
  }
}

// ---------------------------------------------------------------------------
// Status renderers
// ---------------------------------------------------------------------------

export function renderCardStatus(
  statusEl: HTMLElement,
  result: BenchmarkRunResult,
  isControl: boolean,
): void {
  statusEl.empty();
  statusEl.removeClass("is-passed", "is-failed", "is-running", "is-mixed");

  const { passCount, totalCount, avgDurationMs } = result;
  const avgStr = (avgDurationMs / 1000).toFixed(1);

  if (passCount === totalCount) {
    statusEl.addClass("is-passed");
    statusEl.setText(`${passCount}/${totalCount} passed (avg ${avgStr}s)`);
  } else if (passCount === 0) {
    statusEl.addClass("is-failed");
    const label = isControl ? "0/" + totalCount + " (expected)" : `0/${totalCount} passed`;
    statusEl.setText(`${label} (avg ${avgStr}s)`);
  } else {
    statusEl.addClass("is-mixed");
    statusEl.setText(`${passCount}/${totalCount} passed (avg ${avgStr}s)`);
  }
}

export function renderSummary(summaryEl: HTMLElement, stats: SummaryStats): void {
  summaryEl.empty();

  if (stats.totalTests === 0) {
    summaryEl.setText("Run tests to see results.");
    return;
  }

  const headlineEl = summaryEl.createDiv({ cls: "lmsa-benchmark-summary-headline" });
  headlineEl.createSpan({
    cls: stats.allTestsPerfect ? "lmsa-benchmark-summary--pass" : "lmsa-benchmark-summary--mixed",
    text: `${stats.testsFullyPassed}/${stats.totalTests} tests fully passed`,
  });
  headlineEl.createSpan({
    cls: "lmsa-benchmark-summary-detail",
    text: ` (${stats.totalPassed}/${stats.totalIterations} total iterations)`,
  });
}

export function renderSuiteSummary(summaryEl: HTMLElement, stats: SuiteSummaryStats): void {
  renderSummary(summaryEl, stats);

  if (stats.controlResult) {
    const { passCount, totalCount } = stats.controlResult;
    const controlRate = totalCount > 0 ? `${passCount}/${totalCount}` : "—";
    const controlText =
      passCount === totalCount
        ? ` — Control: ${controlRate} passed (annotations may not be needed for this model)`
        : ` — Control: ${controlRate} passed (annotations provide measurable benefit)`;
    summaryEl.createDiv({
      cls: "lmsa-benchmark-summary-control",
      text: controlText,
    });
  }
}

export function renderProgressSummary(
  summaryEl: HTMLElement,
  completedIterations: number,
  totalIterations: number,
): void {
  summaryEl.empty();
  const headlineEl = summaryEl.createDiv({ cls: "lmsa-benchmark-summary-headline" });
  headlineEl.createSpan({
    cls: "lmsa-benchmark-summary-detail",
    text: `Running: ${completedIterations}/${totalIterations} iterations completed`,
  });

  const progressBar = summaryEl.createDiv({ cls: "lmsa-benchmark-summary-progress-bar" });
  const fill = progressBar.createDiv({ cls: "lmsa-benchmark-summary-progress-fill" });
  fill.style.width = `${(completedIterations / totalIterations) * 100}%`;
}

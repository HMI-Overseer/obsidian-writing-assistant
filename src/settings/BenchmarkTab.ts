import { setIcon } from "obsidian";
import type LMStudioWritingAssistant from "../main";
import type { CompletionModel } from "../shared/types";
import { LMStudioModelsService } from "../api";
import { createChatClient } from "../providers/registry";
import { createSettingsSection } from "./ui";
import { getTestCases } from "./benchmark/testCases";
import { runBenchmarkTest, runAllBenchmarks } from "./benchmark/benchmarkRunner";
import type { BenchmarkRunResult, BenchmarkTestCase } from "./benchmark/types";

export function renderBenchmarkTab(
  container: HTMLElement,
  plugin: LMStudioWritingAssistant,
  _refresh: () => void
): void {
  const models = plugin.settings.completionModels;
  let selectedModel: CompletionModel | null = models[0] ?? null;
  let abortController: AbortController | null = null;
  let isRunning = false;
  let iterationCount = 3;

  const testCases = getTestCases();
  const results = new Map<string, BenchmarkRunResult>();

  // -----------------------------------------------------------------------
  // Model selection
  // -----------------------------------------------------------------------

  const modelSection = createSettingsSection(
    container,
    "Model Selection",
    "Choose a completion model to run benchmarks against. The model must be loaded in LM Studio.",
    { icon: "target" }
  );

  if (models.length === 0) {
    modelSection.bodyEl.createEl("p", {
      cls: "lmsa-benchmark-empty",
      text: "No completion models configured. Add one in the Completion Models tab first.",
    });
    return;
  }

  const selectorWrap = modelSection.bodyEl.createDiv({ cls: "lmsa-header-meta-wrap lmsa-benchmark-model-wrap" });
  const selectorBtn = selectorWrap.createDiv({ cls: "lmsa-header-meta lmsa-benchmark-model-selector" });
  const selectorStatusEl = selectorBtn.createEl("span", {
    cls: "lmsa-model-selector-status is-unknown",
  });
  const selectorLabel = selectorBtn.createEl("span", {
    cls: "lmsa-header-meta-label",
    text: selectedModel?.name ?? "Select model...",
  });
  const selectorChevron = selectorBtn.createEl("span", { cls: "lmsa-header-meta-chevron" });
  setIcon(selectorChevron, "chevron-down");

  const selectorDropdown = selectorWrap.createDiv({ cls: "lmsa-model-dropdown" });
  selectorDropdown.style.display = "none";
  let selectorOpen = false;

  const knownAvailability = new Map<string, string>();

  async function refreshModelAvailability(): Promise<void> {
    try {
      const lmSettings = plugin.settings.providerSettings.lmstudio;
      const modelsService = new LMStudioModelsService(
        lmSettings.baseUrl,
        lmSettings.bypassCors
      );
      const result = await modelsService.getCompletionCandidates({ forceRefresh: true });
      knownAvailability.clear();
      for (const candidate of result.candidates) {
        knownAvailability.set(
          candidate.targetModelId,
          candidate.isLoaded ? "loaded" : "unloaded"
        );
      }
    } catch {
      knownAvailability.clear();
    }
    updateSelectorStatus();
  }

  function updateSelectorStatus(): void {
    selectorStatusEl.removeClass("is-loaded", "is-unloaded", "is-unknown", "is-hidden");
    if (!selectedModel?.modelId) {
      selectorStatusEl.addClass("is-hidden");
      return;
    }
    const state = knownAvailability.get(selectedModel.modelId) ?? "unknown";
    selectorStatusEl.addClass(`is-${state}`);
  }

  function closeBenchmarkDropdown(): void {
    selectorDropdown.style.display = "none";
    selectorOpen = false;
    selectorBtn.removeClass("is-active");
    selectorChevron.empty();
    setIcon(selectorChevron, "chevron-down");
  }

  function openBenchmarkDropdown(): void {
    selectorDropdown.empty();
    selectorDropdown.style.display = "block";
    selectorOpen = true;
    selectorBtn.addClass("is-active");
    selectorChevron.empty();
    setIcon(selectorChevron, "chevron-up");

    const listEl = selectorDropdown.createDiv({ cls: "lmsa-model-dropdown-list" });
    for (const m of models) {
      const item = listEl.createDiv({ cls: "lmsa-model-dropdown-item" });
      const checkSpan = item.createEl("span", { cls: "lmsa-model-dropdown-check" });
      if (selectedModel && m.id === selectedModel.id) {
        item.addClass("is-active");
        setIcon(checkSpan, "check");
      }
      const copy = item.createDiv({ cls: "lmsa-model-dropdown-copy" });
      copy.createEl("span", { cls: "lmsa-model-dropdown-name", text: m.name });
      const itemState = knownAvailability.get(m.modelId) ?? "unknown";
      item.createEl("span", { cls: `lmsa-model-dropdown-state is-${itemState}` });
      item.addEventListener("click", (event) => {
        event.stopPropagation();
        selectedModel = m;
        selectorLabel.setText(m.name);
        updateSelectorStatus();
        closeBenchmarkDropdown();
      });
    }
  }

  void refreshModelAvailability();

  selectorBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (selectorOpen) closeBenchmarkDropdown();
    else openBenchmarkDropdown();
  });

  document.addEventListener("click", () => {
    if (selectorOpen) closeBenchmarkDropdown();
  });

  // -----------------------------------------------------------------------
  // Test suite (includes iteration setting, cards, and summary)
  // -----------------------------------------------------------------------

  const suiteSection = createSettingsSection(
    container,
    "Test Suite",
    "Each test sends a synthetic conversation to the model and evaluates whether it correctly interprets edit outcome annotations.",
    { icon: "flask-conical" }
  );

  // Iterations setting
  const iterRow = suiteSection.bodyEl.createDiv({ cls: "lmsa-benchmark-setting-row" });
  const iterInfo = iterRow.createDiv({ cls: "lmsa-benchmark-setting-info" });
  iterInfo.createEl("span", { cls: "lmsa-benchmark-setting-name", text: "Iterations per test" });
  iterInfo.createEl("span", {
    cls: "lmsa-benchmark-setting-desc",
    text: "Run each test multiple times to measure consistency. Higher values give more reliable results but take longer.",
  });
  const iterInput = iterRow.createEl("input", {
    cls: "lmsa-benchmark-setting-input",
    attr: { type: "number", min: "1", max: "20", placeholder: "3", value: String(iterationCount) },
  }) as HTMLInputElement;
  iterInput.addEventListener("input", () => {
    const parsed = parseInt(iterInput.value, 10);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= 20) {
      iterationCount = parsed;
    }
  });

  // Header actions: Run All / Abort
  const runAllBtn = suiteSection.headerActionsEl.createEl("button", {
    cls: "lmsa-benchmark-btn lmsa-benchmark-btn--run-all",
    text: "Run All",
  });

  const abortBtn = suiteSection.headerActionsEl.createEl("button", {
    cls: "lmsa-benchmark-btn lmsa-benchmark-btn--abort",
    text: "Abort",
  });
  abortBtn.style.display = "none";

  const testCardsEl = suiteSection.bodyEl.createDiv({ cls: "lmsa-benchmark-cards" });

  // -----------------------------------------------------------------------
  // Render test cards
  // -----------------------------------------------------------------------

  interface CardRefs {
    statusEl: HTMLElement;
    progressEl: HTMLElement;
    detailsEl: HTMLElement;
    runBtn: HTMLElement;
    toggleBtn: HTMLElement;
  }

  const cardEls = new Map<string, CardRefs>();

  for (const tc of testCases) {
    const card = testCardsEl.createDiv({ cls: "lmsa-benchmark-card" });

    const cardHeader = card.createDiv({ cls: "lmsa-benchmark-card-header" });
    const titleRow = cardHeader.createDiv({ cls: "lmsa-benchmark-card-title-row" });

    const nameEl = titleRow.createSpan({ cls: "lmsa-benchmark-card-name" });
    nameEl.setText(tc.name);
    if (tc.isControl) {
      nameEl.createSpan({ cls: "lmsa-benchmark-badge lmsa-benchmark-badge--control", text: "control" });
    }

    const statusEl = titleRow.createSpan({ cls: "lmsa-benchmark-card-status" });
    statusEl.setText("Not run");

    cardHeader.createEl("p", {
      cls: "lmsa-benchmark-card-desc",
      text: tc.description,
    });

    // Progress indicator (shows during multi-iteration runs)
    const progressEl = cardHeader.createDiv({ cls: "lmsa-benchmark-progress" });
    progressEl.style.display = "none";

    const cardActions = cardHeader.createDiv({ cls: "lmsa-benchmark-card-actions" });

    const runBtn = cardActions.createEl("button", {
      cls: "lmsa-benchmark-btn lmsa-benchmark-btn--run",
    });
    const runIcon = runBtn.createSpan({ cls: "lmsa-benchmark-btn-icon" });
    setIcon(runIcon, "play");
    runBtn.createSpan({ text: "Run" });

    const toggleBtn = cardActions.createEl("button", {
      cls: "lmsa-benchmark-btn lmsa-benchmark-btn--toggle",
    });
    const toggleIcon = toggleBtn.createSpan({ cls: "lmsa-benchmark-btn-icon" });
    setIcon(toggleIcon, "chevron-down");
    toggleBtn.createSpan({ text: "Details" });

    const detailsEl = card.createDiv({ cls: "lmsa-benchmark-card-details" });
    detailsEl.style.display = "none";

    toggleBtn.addClass("is-disabled");

    toggleBtn.addEventListener("click", () => {
      if (toggleBtn.hasClass("is-disabled")) return;
      const visible = detailsEl.style.display !== "none";
      detailsEl.style.display = visible ? "none" : "block";
      toggleIcon.empty();
      setIcon(toggleIcon, visible ? "chevron-down" : "chevron-up");
    });

    runBtn.addEventListener("click", () => {
      if (isRunning || !selectedModel) return;
      runSingleTest(tc);
    });

    cardEls.set(tc.id, { statusEl, progressEl, detailsEl, runBtn, toggleBtn });
  }

  // -----------------------------------------------------------------------
  // Summary (inside test suite section, after cards)
  // -----------------------------------------------------------------------

  const summaryEl = suiteSection.bodyEl.createDiv({ cls: "lmsa-benchmark-summary" });
  summaryEl.setText("Run tests to see results.");

  /** Tracks how many iterations have completed across all tests in the current run. */
  let globalCompletedIterations = 0;
  let globalTotalIterations = 0;

  // -----------------------------------------------------------------------
  // Execution helpers
  // -----------------------------------------------------------------------

  function setRunningState(running: boolean): void {
    isRunning = running;
    runAllBtn.toggleClass("is-disabled", running);
    abortBtn.style.display = running ? "" : "none";

    for (const refs of cardEls.values()) {
      refs.runBtn.toggleClass("is-disabled", running);
    }
  }

  function updateCardProgress(testId: string, completed: number, total: number): void {
    const refs = cardEls.get(testId);
    if (!refs) return;
    refs.progressEl.style.display = "";
    refs.progressEl.setText(`Iteration ${completed}/${total}`);
  }

  function updateCard(testId: string, result: BenchmarkRunResult): void {
    const refs = cardEls.get(testId);
    if (!refs) return;
    results.set(testId, result);

    const { statusEl, progressEl, detailsEl, toggleBtn } = refs;
    progressEl.style.display = "none";
    statusEl.empty();
    statusEl.removeClass("is-passed", "is-failed", "is-running", "is-mixed");
    toggleBtn.removeClass("is-disabled");

    const tc = testCases.find((t) => t.id === testId);
    const { passCount, totalCount, avgDurationMs } = result;
    const avgStr = (avgDurationMs / 1000).toFixed(1);

    if (passCount === totalCount) {
      statusEl.addClass("is-passed");
      statusEl.setText(`${passCount}/${totalCount} passed (avg ${avgStr}s)`);
    } else if (passCount === 0) {
      statusEl.addClass("is-failed");
      const label = tc?.isControl ? "0/" + totalCount + " (expected)" : `0/${totalCount} passed`;
      statusEl.setText(`${label} (avg ${avgStr}s)`);
    } else {
      statusEl.addClass("is-mixed");
      statusEl.setText(`${passCount}/${totalCount} passed (avg ${avgStr}s)`);
    }

    // Populate details with per-iteration results
    detailsEl.empty();

    for (const iter of result.iterations) {
      const iterEl = detailsEl.createDiv({ cls: "lmsa-benchmark-iteration" });

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

      const responseEl = iterEl.createDiv({ cls: "lmsa-benchmark-detail-section" });
      responseEl.createEl("strong", { text: "Model response:" });
      responseEl.createEl("pre", {
        cls: "lmsa-benchmark-response-block",
        text: iter.rawResponse,
      });
    }
  }

  function setCardRunning(testId: string): void {
    const refs = cardEls.get(testId);
    if (!refs) return;
    refs.statusEl.empty();
    refs.statusEl.removeClass("is-passed", "is-failed", "is-mixed");
    refs.statusEl.addClass("is-running");
    refs.statusEl.setText("Running...");
    refs.progressEl.style.display = "";
    refs.progressEl.setText(`Iteration 0/${iterationCount}`);
  }

  function updateSummary(): void {
    summaryEl.empty();

    // While running, show global progress
    if (isRunning && globalTotalIterations > 0) {
      const headlineEl = summaryEl.createDiv({ cls: "lmsa-benchmark-summary-headline" });
      headlineEl.createSpan({
        cls: "lmsa-benchmark-summary-detail",
        text: `Running: ${globalCompletedIterations}/${globalTotalIterations} iterations completed`,
      });

      const progressBar = summaryEl.createDiv({ cls: "lmsa-benchmark-summary-progress-bar" });
      const fill = progressBar.createDiv({ cls: "lmsa-benchmark-summary-progress-fill" });
      fill.style.width = `${(globalCompletedIterations / globalTotalIterations) * 100}%`;
      return;
    }

    const nonControl = testCases.filter((tc) => !tc.isControl);
    const ranTests = nonControl.filter((tc) => results.has(tc.id));

    if (ranTests.length === 0) {
      summaryEl.setText("Run tests to see results.");
      return;
    }

    // Aggregate: total iterations passed / total iterations run
    let totalPassed = 0;
    let totalIterations = 0;
    let allTestsPerfect = true;

    for (const tc of ranTests) {
      const r = results.get(tc.id);
      if (!r) continue;
      totalPassed += r.passCount;
      totalIterations += r.totalCount;
      if (r.passCount < r.totalCount) allTestsPerfect = false;
    }

    const testsFullyPassed = ranTests.filter((tc) => {
      const r = results.get(tc.id);
      return r && r.passCount === r.totalCount;
    }).length;

    const headlineEl = summaryEl.createDiv({ cls: "lmsa-benchmark-summary-headline" });
    headlineEl.createSpan({
      cls: allTestsPerfect ? "lmsa-benchmark-summary--pass" : "lmsa-benchmark-summary--mixed",
      text: `${testsFullyPassed}/${ranTests.length} tests fully passed`,
    });
    headlineEl.createSpan({
      cls: "lmsa-benchmark-summary-detail",
      text: ` (${totalPassed}/${totalIterations} total iterations)`,
    });

    const controlResult = results.get("control-no-annotations");
    if (controlResult) {
      const controlRate = controlResult.totalCount > 0
        ? `${controlResult.passCount}/${controlResult.totalCount}`
        : "—";
      const controlText = controlResult.passCount === controlResult.totalCount
        ? ` — Control: ${controlRate} passed (annotations may not be needed for this model)`
        : ` — Control: ${controlRate} passed (annotations provide measurable benefit)`;
      summaryEl.createDiv({
        cls: "lmsa-benchmark-summary-control",
        text: controlText,
      });
    }
  }

  async function runSingleTest(tc: BenchmarkTestCase): Promise<void> {
    if (!selectedModel) return;
    setRunningState(true);
    abortController = new AbortController();

    globalCompletedIterations = 0;
    globalTotalIterations = iterationCount;

    setCardRunning(tc.id);
    updateSummary();

    try {
      const client = createChatClient(selectedModel.provider, plugin.settings.providerSettings);
      const result = await runBenchmarkTest(
        client,
        selectedModel,
        tc,
        iterationCount,
        (_testId, _iter) => {
          globalCompletedIterations++;
          updateCardProgress(tc.id, globalCompletedIterations, iterationCount);
          updateSummary();
        },
        abortController.signal
      );
      updateCard(tc.id, result);
    } catch (err) {
      const refs = cardEls.get(tc.id);
      if (refs) {
        refs.statusEl.empty();
        refs.progressEl.style.display = "none";
        refs.statusEl.removeClass("is-running", "is-passed", "is-mixed");
        refs.statusEl.addClass("is-failed");
        refs.statusEl.setText(err instanceof Error && err.name === "AbortError" ? "Aborted" : "Error");
      }
    } finally {
      abortController = null;
      setRunningState(false);
      updateSummary();
    }
  }

  // Run All handler
  runAllBtn.addEventListener("click", async () => {
    if (isRunning || !selectedModel) return;
    setRunningState(true);
    abortController = new AbortController();

    globalCompletedIterations = 0;
    globalTotalIterations = testCases.length * iterationCount;

    const iterTracker = new Map<string, number>();
    for (const tc of testCases) {
      setCardRunning(tc.id);
      iterTracker.set(tc.id, 0);
    }
    updateSummary();

    try {
      const client = createChatClient(selectedModel.provider, plugin.settings.providerSettings);
      await runAllBenchmarks(
        client,
        selectedModel,
        testCases,
        iterationCount,
        (result, _index) => {
          updateCard(result.testId, result);
          updateSummary();
        },
        (testId, _iter) => {
          const prev = iterTracker.get(testId) ?? 0;
          iterTracker.set(testId, prev + 1);
          updateCardProgress(testId, prev + 1, iterationCount);
          globalCompletedIterations++;
          updateSummary();
        },
        abortController.signal
      );
    } catch {
      for (const tc of testCases) {
        if (!results.has(tc.id)) {
          const refs = cardEls.get(tc.id);
          if (refs) {
            refs.statusEl.empty();
            refs.progressEl.style.display = "none";
            refs.statusEl.removeClass("is-running", "is-passed", "is-mixed");
            refs.statusEl.addClass("is-failed");
            refs.statusEl.setText("Aborted");
          }
        }
      }
    } finally {
      abortController = null;
      setRunningState(false);
      updateSummary();
    }
  });

  // Abort handler
  abortBtn.addEventListener("click", () => {
    abortController?.abort();
  });
}

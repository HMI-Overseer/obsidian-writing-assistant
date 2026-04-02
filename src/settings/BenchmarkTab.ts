import { setIcon } from "obsidian";
import type LMStudioWritingAssistant from "../main";
import type { CompletionModel, ModelAvailabilityState, ProviderOption } from "../shared/types";
import { getProviderDescriptor, createChatClient } from "../providers/registry";
import { createSettingsSection } from "./ui";
import { getTestSuites } from "./benchmark/testSuites";
import { runBenchmarkTest, runAllBenchmarks } from "./benchmark/benchmarkRunner";
import type { BenchmarkRunResult, BenchmarkTestCase, BenchmarkTestSuite } from "./benchmark/types";
import { ProfileSettingsPopover } from "../chat/models/ProfileSettingsPopover";
import { buildSamplingParams } from "../chat/actions/buildSamplingParams";

export function renderBenchmarkTab(
  container: HTMLElement,
  plugin: LMStudioWritingAssistant,
  _refresh: () => void
): () => void {
  const models = plugin.settings.completionModels;
  let selectedModel: CompletionModel | null = models[0] ?? null;
  let abortController: AbortController | null = null;
  let isRunning = false;
  let iterationCount = 3;

  const suites = getTestSuites();
  const allTestCases = suites.flatMap((s) => s.testCases);
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

  const profileSettingsBtn = selectorWrap.createEl("button", {
    cls: "lmsa-profile-settings-btn",
    attr: { "aria-label": "Profile settings" },
  }) as HTMLButtonElement;
  setIcon(profileSettingsBtn, "settings");

  const profileSettingsPopoverEl = selectorWrap.createDiv({
    cls: "lmsa-profile-popover lmsa-hidden",
  });

  const profilePopover = new ProfileSettingsPopover(
    { profileSettingsBtn, profileSettingsPopoverEl },
    {
      getActiveModel: () => selectedModel,
      onCacheSettingsChange: async (modelId, settings) => {
        const model = plugin.settings.completionModels.find((m) => m.id === modelId);
        if (model) {
          model.anthropicCacheSettings = settings;
          await plugin.saveSettings();
        }
      },
      getParamSettings: () => ({
        globalSystemPrompt: plugin.settings.globalSystemPrompt,
        globalTemperature: plugin.settings.globalTemperature,
        globalMaxTokens: plugin.settings.globalMaxTokens,
        globalTopP: plugin.settings.globalTopP,
        globalTopK: plugin.settings.globalTopK,
        globalMinP: plugin.settings.globalMinP,
        globalRepeatPenalty: plugin.settings.globalRepeatPenalty,
        globalReasoning: plugin.settings.globalReasoning,
      }),
      onSystemPromptChange: async (value) => {
        plugin.settings.globalSystemPrompt = value;
        await plugin.saveSettings();
      },
      onTemperatureChange: async (value) => {
        plugin.settings.globalTemperature = value;
        await plugin.saveSettings();
      },
      onMaxTokensChange: async (value) => {
        plugin.settings.globalMaxTokens = value;
        await plugin.saveSettings();
      },
      onTopPChange: async (value) => {
        plugin.settings.globalTopP = value;
        await plugin.saveSettings();
      },
      onTopKChange: async (value) => {
        plugin.settings.globalTopK = value;
        await plugin.saveSettings();
      },
      onMinPChange: async (value) => {
        plugin.settings.globalMinP = value;
        await plugin.saveSettings();
      },
      onRepeatPenaltyChange: async (value) => {
        plugin.settings.globalRepeatPenalty = value;
        await plugin.saveSettings();
      },
      onReasoningChange: async (value) => {
        plugin.settings.globalReasoning = value;
        await plugin.saveSettings();
      },
    }
  );
  profilePopover.syncVisibility();

  const selectorDropdown = selectorWrap.createDiv({ cls: "lmsa-model-dropdown lmsa-hidden" });
  let selectorOpen = false;

  function getModelState(modelId: string, provider: ProviderOption): ModelAvailabilityState {
    return plugin.modelAvailability.getAvailability(modelId, provider).state;
  }

  async function refreshModelAvailability(): Promise<void> {
    if (selectedModel) {
      const descriptor = getProviderDescriptor(selectedModel.provider);
      if (descriptor.kind !== "cloud") {
        try {
          await plugin.modelAvailability.refreshLocalModels({ forceRefresh: true });
        } catch { /* handled by service */ }
      }
    }
    updateSelectorStatus();
  }

  function updateSelectorStatus(): void {
    selectorStatusEl.removeClass("is-loaded", "is-unloaded", "is-unknown", "is-cloud", "is-hidden");
    if (!selectedModel?.modelId) {
      selectorStatusEl.addClass("is-hidden");
      return;
    }
    const state = getModelState(selectedModel.modelId, selectedModel.provider);
    selectorStatusEl.addClass(`is-${state}`);
  }

  function closeBenchmarkDropdown(): void {
    selectorDropdown.addClass("lmsa-hidden");
    selectorOpen = false;
    selectorBtn.removeClass("is-active");
    selectorChevron.empty();
    setIcon(selectorChevron, "chevron-down");
  }

  function openBenchmarkDropdown(): void {
    selectorDropdown.empty();
    selectorDropdown.removeClass("lmsa-hidden");
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
      const itemState = getModelState(m.modelId, m.provider);
      item.createEl("span", { cls: `lmsa-model-dropdown-state is-${itemState}` });
      item.addEventListener("click", (event) => {
        event.stopPropagation();
        selectedModel = m;
        selectorLabel.setText(m.name);
        updateSelectorStatus();
        profilePopover.syncVisibility();
        closeBenchmarkDropdown();
      });
    }
  }

  void refreshModelAvailability();

  selectorBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (profilePopover.isOpen()) profilePopover.close();
    if (selectorOpen) closeBenchmarkDropdown();
    else openBenchmarkDropdown();
  });

  const onDocumentClick = (): void => {
    if (selectorOpen) closeBenchmarkDropdown();
  };
  document.addEventListener("click", onDocumentClick);

  // -----------------------------------------------------------------------
  // Test suites section
  // -----------------------------------------------------------------------

  const suitesSection = createSettingsSection(container, "Test Suites", undefined, {
    icon: "flask-conical",
  });

  // Header actions: Run All / Abort
  const runAllBtn = suitesSection.headerActionsEl.createEl("button", {
    cls: "lmsa-benchmark-btn lmsa-benchmark-btn--run-all",
    text: "Run All",
  });

  const abortBtn = suitesSection.headerActionsEl.createEl("button", {
    cls: "lmsa-benchmark-btn lmsa-benchmark-btn--abort",
    text: "Abort",
  });
  abortBtn.addClass("lmsa-hidden");

  // Iterations setting (global, shared across suites)
  const iterRow = suitesSection.bodyEl.createDiv({ cls: "lmsa-benchmark-setting-row" });
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

  // -----------------------------------------------------------------------
  // Tab bar
  // -----------------------------------------------------------------------

  const tabBar = suitesSection.bodyEl.createDiv({ cls: "lmsa-benchmark-tab-bar" });

  interface CardRefs {
    statusEl: HTMLElement;
    progressEl: HTMLElement;
    detailsEl: HTMLElement;
    runBtn: HTMLElement;
    toggleBtn: HTMLElement;
  }

  interface SuiteRefs {
    tabBtn: HTMLElement;
    contentEl: HTMLElement;
    cardEls: Map<string, CardRefs>;
    summaryEl: HTMLElement;
    runSuiteBtn: HTMLElement;
  }

  const suiteRefs = new Map<string, SuiteRefs>();
  let activeSuiteId = suites[0]?.id ?? "";

  for (const suite of suites) {
    // --- Tab button ---
    const tabBtn = tabBar.createEl("button", { cls: "lmsa-benchmark-tab" });
    if (suite.icon) {
      const iconEl = tabBtn.createSpan({ cls: "lmsa-benchmark-tab-icon" });
      setIcon(iconEl, suite.icon);
    }
    tabBtn.createSpan({ text: suite.name });
    if (suite.id === activeSuiteId) tabBtn.addClass("is-active");

    // --- Content panel ---
    const contentEl = suitesSection.bodyEl.createDiv({ cls: "lmsa-benchmark-tab-content" });
    if (suite.id !== activeSuiteId) contentEl.addClass("lmsa-hidden");

    // Suite description
    contentEl.createEl("p", {
      cls: "lmsa-settings-section-desc",
      text: suite.description,
    });

    // Empty suite placeholder
    const isEmpty = suite.testCases.length === 0;

    // Suite actions: Run Suite
    const suiteActionsEl = contentEl.createDiv({ cls: "lmsa-benchmark-suite-actions" });
    const runSuiteBtn = suiteActionsEl.createEl("button", {
      cls: "lmsa-benchmark-btn lmsa-benchmark-btn--run-suite",
    });
    const runSuiteIcon = runSuiteBtn.createSpan({ cls: "lmsa-benchmark-btn-icon" });
    setIcon(runSuiteIcon, "play");
    runSuiteBtn.createSpan({ text: "Run suite" });

    if (isEmpty) {
      suiteActionsEl.addClass("lmsa-hidden");
      contentEl.createEl("p", {
        cls: "lmsa-benchmark-empty",
        text: "No tests in this suite yet.",
      });
    }

    // Test cards
    const testCardsEl = contentEl.createDiv({ cls: "lmsa-benchmark-cards" });
    const cardEls = new Map<string, CardRefs>();

    for (const tc of suite.testCases) {
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

      const progressEl = cardHeader.createDiv({ cls: "lmsa-benchmark-progress" });
      progressEl.addClass("lmsa-hidden");

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

      const detailsEl = card.createDiv({ cls: "lmsa-benchmark-card-details lmsa-hidden" });
      toggleBtn.addClass("is-disabled");

      toggleBtn.addEventListener("click", () => {
        if (toggleBtn.hasClass("is-disabled")) return;
        const visible = !detailsEl.hasClass("lmsa-hidden");
        detailsEl.toggleClass("lmsa-hidden", visible);
        toggleIcon.empty();
        setIcon(toggleIcon, visible ? "chevron-down" : "chevron-up");
      });

      runBtn.addEventListener("click", () => {
        if (isRunning || !selectedModel) return;
        runSingleTest(tc);
      });

      cardEls.set(tc.id, { statusEl, progressEl, detailsEl, runBtn, toggleBtn });
    }

    // Suite summary (hidden for empty suites)
    const summaryEl = contentEl.createDiv({ cls: "lmsa-benchmark-summary" });
    if (isEmpty) {
      summaryEl.addClass("lmsa-hidden");
    } else {
      summaryEl.setText("Run tests to see results.");
    }

    suiteRefs.set(suite.id, { tabBtn, contentEl, cardEls, summaryEl, runSuiteBtn });

    // --- Tab click handler ---
    tabBtn.addEventListener("click", () => {
      if (suite.id === activeSuiteId) return;
      switchToSuite(suite.id);
    });

    // --- Run Suite handler ---
    runSuiteBtn.addEventListener("click", () => {
      if (isRunning || !selectedModel) return;
      runSuite(suite);
    });
  }

  // Global summary (aggregate across all suites)
  const globalSummaryEl = suitesSection.bodyEl.createDiv({ cls: "lmsa-benchmark-summary" });
  globalSummaryEl.setText("Run tests to see results.");

  function switchToSuite(suiteId: string): void {
    const prev = suiteRefs.get(activeSuiteId);
    if (prev) {
      prev.tabBtn.removeClass("is-active");
      prev.contentEl.addClass("lmsa-hidden");
    }
    activeSuiteId = suiteId;
    const next = suiteRefs.get(suiteId);
    if (next) {
      next.tabBtn.addClass("is-active");
      next.contentEl.removeClass("lmsa-hidden");
    }
  }

  // -----------------------------------------------------------------------
  // Global progress tracking
  // -----------------------------------------------------------------------

  let globalCompletedIterations = 0;
  let globalTotalIterations = 0;

  // -----------------------------------------------------------------------
  // Execution helpers
  // -----------------------------------------------------------------------

  function setRunningState(running: boolean): void {
    isRunning = running;
    runAllBtn.toggleClass("is-disabled", running);
    abortBtn.toggleClass("lmsa-hidden", !running);
    profileSettingsBtn.disabled = running;

    if (running && profilePopover.isOpen()) {
      profilePopover.close();
    }

    for (const refs of suiteRefs.values()) {
      refs.runSuiteBtn.toggleClass("is-disabled", running);
      for (const card of refs.cardEls.values()) {
        card.runBtn.toggleClass("is-disabled", running);
      }
    }
  }

  function getCardRefs(testId: string): CardRefs | undefined {
    for (const refs of suiteRefs.values()) {
      const card = refs.cardEls.get(testId);
      if (card) return card;
    }
    return undefined;
  }

  function findSuiteForTest(testId: string): BenchmarkTestSuite | undefined {
    return suites.find((s) => s.testCases.some((tc) => tc.id === testId));
  }

  function updateCardProgress(testId: string, completed: number, total: number): void {
    const refs = getCardRefs(testId);
    if (!refs) return;
    refs.progressEl.removeClass("lmsa-hidden");
    refs.progressEl.setText(`Iteration ${completed}/${total}`);
  }

  function updateCard(testId: string, result: BenchmarkRunResult): void {
    const refs = getCardRefs(testId);
    if (!refs) return;
    results.set(testId, result);

    const { statusEl, progressEl, detailsEl, toggleBtn } = refs;
    progressEl.addClass("lmsa-hidden");
    statusEl.empty();
    statusEl.removeClass("is-passed", "is-failed", "is-running", "is-mixed");
    toggleBtn.removeClass("is-disabled");

    const tc = allTestCases.find((t) => t.id === testId);
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
    const refs = getCardRefs(testId);
    if (!refs) return;
    refs.statusEl.empty();
    refs.statusEl.removeClass("is-passed", "is-failed", "is-mixed");
    refs.statusEl.addClass("is-running");
    refs.statusEl.setText("Running...");
    refs.progressEl.removeClass("lmsa-hidden");
    refs.progressEl.setText(`Iteration 0/${iterationCount}`);
  }

  function updateSuiteSummary(suite: BenchmarkTestSuite): void {
    const refs = suiteRefs.get(suite.id);
    if (!refs) return;
    const { summaryEl } = refs;
    summaryEl.empty();

    const nonControl = suite.testCases.filter((tc) => !tc.isControl);
    const ranTests = nonControl.filter((tc) => results.has(tc.id));

    if (ranTests.length === 0) {
      summaryEl.setText("Run tests to see results.");
      return;
    }

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

    // Show control result if this suite has one
    const controlCase = suite.testCases.find((tc) => tc.isControl);
    if (controlCase) {
      const controlResult = results.get(controlCase.id);
      if (controlResult) {
        const controlRate =
          controlResult.totalCount > 0
            ? `${controlResult.passCount}/${controlResult.totalCount}`
            : "—";
        const controlText =
          controlResult.passCount === controlResult.totalCount
            ? ` — Control: ${controlRate} passed (annotations may not be needed for this model)`
            : ` — Control: ${controlRate} passed (annotations provide measurable benefit)`;
        summaryEl.createDiv({
          cls: "lmsa-benchmark-summary-control",
          text: controlText,
        });
      }
    }
  }

  function updateGlobalSummary(): void {
    globalSummaryEl.empty();

    // While running, show global progress
    if (isRunning && globalTotalIterations > 0) {
      const headlineEl = globalSummaryEl.createDiv({ cls: "lmsa-benchmark-summary-headline" });
      headlineEl.createSpan({
        cls: "lmsa-benchmark-summary-detail",
        text: `Running: ${globalCompletedIterations}/${globalTotalIterations} iterations completed`,
      });

      const progressBar = globalSummaryEl.createDiv({ cls: "lmsa-benchmark-summary-progress-bar" });
      const fill = progressBar.createDiv({ cls: "lmsa-benchmark-summary-progress-fill" });
      fill.style.width = `${(globalCompletedIterations / globalTotalIterations) * 100}%`;
      return;
    }

    const nonControl = allTestCases.filter((tc) => !tc.isControl);
    const ranTests = nonControl.filter((tc) => results.has(tc.id));

    if (ranTests.length === 0) {
      globalSummaryEl.setText("Run tests to see results.");
      return;
    }

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

    const headlineEl = globalSummaryEl.createDiv({ cls: "lmsa-benchmark-summary-headline" });
    headlineEl.createSpan({
      cls: allTestsPerfect ? "lmsa-benchmark-summary--pass" : "lmsa-benchmark-summary--mixed",
      text: `${testsFullyPassed}/${ranTests.length} tests fully passed`,
    });
    headlineEl.createSpan({
      cls: "lmsa-benchmark-summary-detail",
      text: ` (${totalPassed}/${totalIterations} total iterations)`,
    });
  }

  // -----------------------------------------------------------------------
  // Run handlers
  // -----------------------------------------------------------------------

  async function runSingleTest(tc: BenchmarkTestCase): Promise<void> {
    if (!selectedModel) return;
    setRunningState(true);
    abortController = new AbortController();

    globalCompletedIterations = 0;
    globalTotalIterations = iterationCount;

    setCardRunning(tc.id);
    updateGlobalSummary();

    const suite = findSuiteForTest(tc.id);

    try {
      const client = createChatClient(selectedModel.provider, plugin.settings.providerSettings);
      const result = await runBenchmarkTest(
        client,
        selectedModel,
        tc,
        iterationCount,
        buildSamplingParams(plugin.settings),
        (_testId, _iter) => {
          globalCompletedIterations++;
          updateCardProgress(tc.id, globalCompletedIterations, iterationCount);
          updateGlobalSummary();
        },
        abortController.signal
      );
      updateCard(tc.id, result);
    } catch (err) {
      const refs = getCardRefs(tc.id);
      if (refs) {
        refs.statusEl.empty();
        refs.progressEl.addClass("lmsa-hidden");
        refs.statusEl.removeClass("is-running", "is-passed", "is-mixed");
        refs.statusEl.addClass("is-failed");
        refs.statusEl.setText(err instanceof Error && err.name === "AbortError" ? "Aborted" : "Error");
      }
    } finally {
      abortController = null;
      setRunningState(false);
      if (suite) updateSuiteSummary(suite);
      updateGlobalSummary();
    }
  }

  async function runSuite(suite: BenchmarkTestSuite): Promise<void> {
    if (!selectedModel) return;
    setRunningState(true);
    abortController = new AbortController();

    globalCompletedIterations = 0;
    globalTotalIterations = suite.testCases.length * iterationCount;

    const iterTracker = new Map<string, number>();
    for (const tc of suite.testCases) {
      setCardRunning(tc.id);
      iterTracker.set(tc.id, 0);
    }
    updateGlobalSummary();

    try {
      const client = createChatClient(selectedModel.provider, plugin.settings.providerSettings);
      await runAllBenchmarks(
        client,
        selectedModel,
        suite.testCases,
        iterationCount,
        buildSamplingParams(plugin.settings),
        (result, _index) => {
          updateCard(result.testId, result);
          updateSuiteSummary(suite);
          updateGlobalSummary();
        },
        (testId, _iter) => {
          const prev = iterTracker.get(testId) ?? 0;
          iterTracker.set(testId, prev + 1);
          updateCardProgress(testId, prev + 1, iterationCount);
          globalCompletedIterations++;
          updateGlobalSummary();
        },
        abortController.signal
      );
    } catch {
      for (const tc of suite.testCases) {
        if (!results.has(tc.id)) {
          const refs = getCardRefs(tc.id);
          if (refs) {
            refs.statusEl.empty();
            refs.progressEl.addClass("lmsa-hidden");
            refs.statusEl.removeClass("is-running", "is-passed", "is-mixed");
            refs.statusEl.addClass("is-failed");
            refs.statusEl.setText("Aborted");
          }
        }
      }
    } finally {
      abortController = null;
      setRunningState(false);
      updateSuiteSummary(suite);
      updateGlobalSummary();
    }
  }

  // Run All handler — runs all suites sequentially
  runAllBtn.addEventListener("click", async () => {
    if (isRunning || !selectedModel) return;
    setRunningState(true);
    abortController = new AbortController();

    globalCompletedIterations = 0;
    globalTotalIterations = allTestCases.length * iterationCount;

    const iterTracker = new Map<string, number>();
    for (const tc of allTestCases) {
      setCardRunning(tc.id);
      iterTracker.set(tc.id, 0);
    }
    updateGlobalSummary();

    try {
      const client = createChatClient(selectedModel.provider, plugin.settings.providerSettings);
      for (const suite of suites) {
        if (abortController.signal.aborted) break;
        await runAllBenchmarks(
          client,
          selectedModel,
          suite.testCases,
          iterationCount,
          buildSamplingParams(plugin.settings),
          (result, _index) => {
            updateCard(result.testId, result);
            updateSuiteSummary(suite);
            updateGlobalSummary();
          },
          (testId, _iter) => {
            const prev = iterTracker.get(testId) ?? 0;
            iterTracker.set(testId, prev + 1);
            updateCardProgress(testId, prev + 1, iterationCount);
            globalCompletedIterations++;
            updateGlobalSummary();
          },
          abortController.signal
        );
      }
    } catch {
      for (const tc of allTestCases) {
        if (!results.has(tc.id)) {
          const refs = getCardRefs(tc.id);
          if (refs) {
            refs.statusEl.empty();
            refs.progressEl.addClass("lmsa-hidden");
            refs.statusEl.removeClass("is-running", "is-passed", "is-mixed");
            refs.statusEl.addClass("is-failed");
            refs.statusEl.setText("Aborted");
          }
        }
      }
    } finally {
      abortController = null;
      setRunningState(false);
      for (const suite of suites) updateSuiteSummary(suite);
      updateGlobalSummary();
    }
  });

  // Abort handler
  abortBtn.addEventListener("click", () => {
    abortController?.abort();
  });

  return () => {
    document.removeEventListener("click", onDocumentClick);
    profilePopover.destroy();
    abortController?.abort();
  };
}

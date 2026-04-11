import { setIcon } from "obsidian";
import type WritingAssistantChat from "../main";
import type { CompletionModel, ProviderProfile } from "../shared/types";
import { getProviderDescriptor, createChatClient } from "../providers/registry";
import { PROVIDER_DESCRIPTORS } from "../providers/descriptors";
import { createSettingsSection, createModelSelector } from "./ui";
import { getTestSuites } from "./benchmark/testSuites";
import { runBenchmarkTest, runAllBenchmarks } from "./benchmark/benchmarkRunner";
import type { BenchmarkRunResult, BenchmarkTestCase, BenchmarkTestSuite, EvaluationCriteria, BenchmarkMessage } from "./benchmark/types";
import { ProfileSettingsPopover } from "../chat/models/ProfileSettingsPopover";
import { buildSamplingParams } from "../chat/finalization/buildSamplingParams";
import { getActiveProfile, getProfilesForProvider, generateProfileId } from "../shared/profileUtils";
import { makeDefaultProfile } from "../constants";

export function renderBenchmarkTab(
  container: HTMLElement,
  plugin: WritingAssistantChat,
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
      text: "No completion models configured. Add one in the completion models tab first.",
    });
    return;
  }

  const selector = createModelSelector(modelSection.bodyEl, models, {
    getAvailability: (modelId, provider) =>
      plugin.services.modelAvailability.getAvailability(modelId, provider).state,
    refreshLocalModels: async () => {
      if (selectedModel) {
        const descriptor = getProviderDescriptor(selectedModel.provider);
        if (descriptor.kind !== "cloud") {
          await plugin.services.modelAvailability.refreshLocalModels({ forceRefresh: true });
        }
      }
    },
  }, {
    initial: selectedModel,
    onSelect: (model) => {
      selectedModel = model as CompletionModel | null;
      profilePopover.syncVisibility();
    },
  });

  // Add benchmark-specific class for right-aligned layout
  selector.wrapEl.addClass("lmsa-benchmark-model-wrap");

  const profileSettingsBtn = selector.wrapEl.createEl("button", {
    cls: "lmsa-profile-settings-btn",
    attr: { "aria-label": "Profile settings" },
  }) as HTMLButtonElement;
  setIcon(profileSettingsBtn, "settings");

  const profileSettingsPopoverEl = selector.wrapEl.createDiv({
    cls: "lmsa-profile-popover lmsa-hidden",
  });

  const profilePopover = new ProfileSettingsPopover(
    { profileSettingsBtn, profileSettingsPopoverEl },
    {
      getActiveModel: () => selectedModel,
      getProfilesForProvider: (provider) =>
        getProfilesForProvider(plugin.settings, provider),
      getActiveProfile: (provider) =>
        getActiveProfile(plugin.settings, provider),
      getProviderDescriptor: (provider) => PROVIDER_DESCRIPTORS[provider],
      onProfileSelect: async (profileId) => {
        if (!selectedModel) return;
        plugin.settings.activeProfileIds[selectedModel.provider] = profileId;
        await plugin.saveSettings();
      },
      onProfileCreate: async (name, provider) => {
        const profile: ProviderProfile = {
          ...makeDefaultProfile(provider),
          id: generateProfileId(provider),
          name,
          isDefault: false,
        };
        plugin.settings.providerProfiles.push(profile);
        plugin.settings.activeProfileIds[provider] = profile.id;
        await plugin.saveSettings();
        return profile;
      },
      onProfileDelete: async (profileId) => {
        const idx = plugin.settings.providerProfiles.findIndex((p) => p.id === profileId);
        if (idx === -1) return;
        const deleted = plugin.settings.providerProfiles[idx];
        plugin.settings.providerProfiles.splice(idx, 1);
        if (plugin.settings.activeProfileIds[deleted.provider] === profileId) {
          plugin.settings.activeProfileIds[deleted.provider] = `${deleted.provider}-default`;
        }
        await plugin.saveSettings();
      },
      onProfileUpdate: async (profileId, patch) => {
        const profile = plugin.settings.providerProfiles.find((p) => p.id === profileId);
        if (!profile || profile.isDefault) return;
        Object.assign(profile, patch);
        await plugin.saveSettings();
      },
    },
  );
  profilePopover.syncVisibility();

  // -----------------------------------------------------------------------
  // Test suites section
  // -----------------------------------------------------------------------

  const suitesSection = createSettingsSection(container, "Test Suites", undefined, {
    icon: "flask-conical",
  });

  // Header actions: Run All / Abort
  const runAllBtn = suitesSection.headerActionsEl.createEl("button", {
    cls: "lmsa-benchmark-btn lmsa-benchmark-btn--run-all",
    text: "Run all",
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
    resultsContainerEl: HTMLElement;
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

      // Static details — always visible when expanded
      if (tc.criteria) {
        renderCriteria(detailsEl, tc.criteria);
      }
      renderConversationPreview(detailsEl, tc.messages);

      // Results container — populated after run
      const resultsContainerEl = detailsEl.createDiv({ cls: "lmsa-benchmark-results-container" });

      toggleBtn.addEventListener("click", () => {
        const visible = !detailsEl.hasClass("lmsa-hidden");
        detailsEl.toggleClass("lmsa-hidden", visible);
        toggleIcon.empty();
        setIcon(toggleIcon, visible ? "chevron-down" : "chevron-up");
      });

      runBtn.addEventListener("click", () => {
        if (isRunning || !selectedModel) return;
        runSingleTest(tc);
      });

      cardEls.set(tc.id, { statusEl, progressEl, detailsEl, resultsContainerEl, runBtn, toggleBtn });
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

    const { statusEl, progressEl, resultsContainerEl } = refs;
    progressEl.addClass("lmsa-hidden");
    statusEl.empty();
    statusEl.removeClass("is-passed", "is-failed", "is-running", "is-mixed");

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

    // Populate results container with per-iteration results (preserves static criteria/conversation)
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

      // Show tool calls if present
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
      const profile = getActiveProfile(plugin.settings, selectedModel.provider);
      const result = await runBenchmarkTest(
        client,
        selectedModel,
        tc,
        iterationCount,
        buildSamplingParams(profile),
        (_testId, _iter) => {
          globalCompletedIterations++;
          updateCardProgress(tc.id, globalCompletedIterations, iterationCount);
          updateGlobalSummary();
        },
        abortController.signal,
        profile.anthropicCacheSettings,
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
      const profile = getActiveProfile(plugin.settings, selectedModel.provider);
      await runAllBenchmarks(
        client,
        selectedModel,
        suite.testCases,
        iterationCount,
        buildSamplingParams(profile),
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
        abortController.signal,
        profile.anthropicCacheSettings,
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
      const profile = getActiveProfile(plugin.settings, selectedModel.provider);
      for (const suite of suites) {
        if (abortController.signal.aborted) break;
        await runAllBenchmarks(
          client,
          selectedModel,
          suite.testCases,
          iterationCount,
          buildSamplingParams(profile),
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
          abortController.signal,
          profile.anthropicCacheSettings,
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
    selector.destroy();
    profilePopover.destroy();
    abortController?.abort();
  };
}

// ---------------------------------------------------------------------------
// Static detail renderers
// ---------------------------------------------------------------------------

function renderCriteria(container: HTMLElement, criteria: EvaluationCriteria): void {
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

function renderConversationPreview(container: HTMLElement, messages: BenchmarkMessage[]): void {
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

import { Notice, setIcon } from "obsidian";
import type WritingAssistantChat from "../main";
import type {
  BenchmarkRunConditions,
  CompletionModel,
  ProviderProfile,
  SamplingParams,
} from "../shared/types";
import { MAX_BENCHMARK_HISTORY } from "../constants";
import { createChatClient } from "../providers/registry";
import { PROVIDER_DESCRIPTORS } from "../providers/descriptors";
import { getSelectableCompletionModels } from "../providers/selectableModels";
import { createSettingsSection, createModelSelector, pluginModelDropdownDeps, SettingItem } from "./ui";
import { getTestSuites } from "./benchmark/testSuites";
import { reportIfRejected, voidAsync } from "../asyncCallbacks";
import { runBenchmarkTest, runAllBenchmarks } from "./benchmark/benchmarkRunner";
import type { BenchmarkTestCase, BenchmarkTestSuite, BenchmarkRunResult } from "./benchmark/types";
import { computeSummaryStats, computeSuiteSummary } from "./benchmark/BenchmarkSummary";
import {
  renderCriteria,
  renderConversationPreview,
  renderCardResults,
  renderCardStatus,
  renderSummary,
  renderSuiteSummary,
  renderProgressSummary,
} from "./benchmark/BenchmarkRenderers";
import { assessPace, PACE_ADVICE } from "./benchmark/pace";
import {
  buildBenchmarkReport,
  buildHistoryEntry,
  buildReportFileName,
} from "./benchmark/reportBuilder";
import type { SuiteReportSection } from "./benchmark/reportBuilder";
import { writeBenchmarkReport } from "./benchmark/reportWriter";
import { ProfileSettingsPopover } from "../chat/models/ProfileSettingsPopover";
import { buildSamplingParams } from "../chat/finalization/buildSamplingParams";
import { resolveModelReasoning, resolveReasoningLevels } from "../providers/reasoningLevels";
import { getActiveProfile, getProfilesForProvider, generateProfileId } from "../shared/profileUtils";
import { makeDefaultProfile } from "../constants";

export function renderBenchmarkTab(
  container: HTMLElement,
  plugin: WritingAssistantChat,
  _refresh: () => void
): () => void {
  const models = getSelectableCompletionModels(plugin.settings);
  let selectedModel: CompletionModel | null = models[0] ?? null;
  let abortController: AbortController | null = null;
  let isRunning = false;
  let iterationCount = 3;

  const suites = getTestSuites();
  const allTestCases = suites.flatMap((s) => s.testCases);
  const results = new Map<string, BenchmarkRunResult>();
  let lastRunConditions: BenchmarkRunConditions | null = null;
  let errorNoticedThisRun = false;

  // -----------------------------------------------------------------------
  // Model selection
  // -----------------------------------------------------------------------

  const modelSection = createSettingsSection(
    container,
    "Model selection",
    "Choose a completion model to run benchmarks against. The model must be loaded.",
    { icon: "target" }
  );

  if (models.length === 0) {
    modelSection.bodyEl.createEl("p", {
      cls: "lmsa-benchmark-empty",
      text: "No models available. Enable a provider in settings first.",
    });
    return () => {};
  }

  const modelItem = new SettingItem(modelSection.bodyEl)
    .setName("Completion model")
    .setDesc("The model used to run benchmark tests.");

  const selector = createModelSelector(modelItem.settingEl, models, pluginModelDropdownDeps(plugin), {
    initial: selectedModel,
    onSelect: (model) => {
      selectedModel = model as CompletionModel | null;
      profilePopover.syncVisibility();
    },
  });

  selector.wrapEl.addClass("lmsa-benchmark-model-wrap");

  const profileSettingsBtn = selector.wrapEl.createEl("button", {
    cls: "lmsa-profile-settings-btn",
    attr: { "aria-label": "Profile settings" },
  });
  setIcon(profileSettingsBtn, "settings");

  const profileSettingsPopoverEl = selector.wrapEl.createDiv({
    cls: "lmsa-profile-popover lmsa-hidden",
  });

  const profilePopover = new ProfileSettingsPopover(
    { profileSettingsBtn, profileSettingsPopoverEl },
    {
      getActiveModel: () => selectedModel,
      isProviderEnabled: (provider) => plugin.settings.providerSettings[provider].enabled,
      getProfilesForProvider: (provider) =>
        getProfilesForProvider(plugin.settings, provider),
      getActiveProfile: (provider) =>
        getActiveProfile(plugin.settings, provider),
      getProviderDescriptor: (provider) => PROVIDER_DESCRIPTORS[provider],
      onProfileSelect: async (profileId, provider) => {
        plugin.settings.activeProfileIds[provider] = profileId;
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
      getModelReasoning: () =>
        selectedModel
          ? resolveModelReasoning(
              plugin.settings.reasoningByModelKey,
              selectedModel,
              plugin.services.modelAvailability,
            )
          : null,
      getModelReasoningLevels: () =>
        selectedModel
          ? resolveReasoningLevels(selectedModel, plugin.services.modelAvailability)
          : [],
      onModelReasoningChange: async (level) => {
        if (!selectedModel) return;
        if (level === null) delete plugin.settings.reasoningByModelKey[selectedModel.id];
        else plugin.settings.reasoningByModelKey[selectedModel.id] = level;
        await plugin.saveSettings();
      },
    },
  );
  profilePopover.syncVisibility();

  // -----------------------------------------------------------------------
  // Test suites section
  // -----------------------------------------------------------------------

  const suitesSection = createSettingsSection(container, "Test suites", undefined, {
    icon: "flask-conical",
  });

  const exportBtn = suitesSection.headerActionsEl.createEl("button", {
    cls: "lmsa-benchmark-btn lmsa-benchmark-btn--export",
    text: "Export report",
  });

  const runAllBtn = suitesSection.headerActionsEl.createEl("button", {
    cls: "lmsa-benchmark-btn lmsa-benchmark-btn--run-all",
    text: "Run all",
  });

  const abortBtn = suitesSection.headerActionsEl.createEl("button", {
    cls: "lmsa-benchmark-btn lmsa-benchmark-btn--abort",
    text: "Abort",
  });
  abortBtn.addClass("lmsa-hidden");

  // Iterations setting
  const iterRow = suitesSection.bodyEl.createDiv({ cls: "lmsa-benchmark-setting-row" });
  const iterInfo = iterRow.createDiv({ cls: "lmsa-benchmark-setting-info" });
  iterInfo.createSpan({ cls: "lmsa-benchmark-setting-name", text: "Iterations per test" });
  iterInfo.createSpan({
    cls: "lmsa-benchmark-setting-desc",
    text: "Run each test multiple times to measure consistency. Higher values give more reliable results but take longer.",
  });
  const iterInput = iterRow.createEl("input", {
    cls: "lmsa-benchmark-setting-input",
    attr: { type: "number", min: "1", max: "20", placeholder: "3", value: String(iterationCount) },
  });
  iterInput.addEventListener("input", () => {
    const parsed = parseInt(iterInput.value, 10);
    if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 20) {
      iterationCount = parsed;
    }
  });

  // Report folder setting
  const folderRow = suitesSection.bodyEl.createDiv({ cls: "lmsa-benchmark-setting-row" });
  const folderInfo = folderRow.createDiv({ cls: "lmsa-benchmark-setting-info" });
  folderInfo.createSpan({ cls: "lmsa-benchmark-setting-name", text: "Report folder" });
  folderInfo.createSpan({
    cls: "lmsa-benchmark-setting-desc",
    text: "Vault folder where exported benchmark reports are created.",
  });
  const folderInput = folderRow.createEl("input", {
    cls: "lmsa-benchmark-setting-input lmsa-benchmark-setting-input--wide",
    attr: { type: "text", placeholder: "Benchmarks", value: plugin.settings.benchmark.reportFolder },
  });
  folderInput.addEventListener("change", () => {
    void (async () => {
      plugin.settings.benchmark.reportFolder = folderInput.value.trim() || "Benchmarks";
      await plugin.saveSettings();
    })();
  });

  // Pace warning banner, shown when iterations of the current run trend slow.
  const paceWarningEl = suitesSection.bodyEl.createDiv({
    cls: "lmsa-benchmark-warning lmsa-hidden",
  });
  const paceWarningIconEl = paceWarningEl.createSpan({ cls: "lmsa-benchmark-warning-icon" });
  setIcon(paceWarningIconEl, "alert-triangle");
  const paceWarningTextEl = paceWarningEl.createSpan({ cls: "lmsa-benchmark-warning-text" });

  // -----------------------------------------------------------------------
  // Tab bar & test cards
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
    const tabBtn = tabBar.createEl("button", { cls: "lmsa-benchmark-tab" });
    if (suite.icon) {
      const iconEl = tabBtn.createSpan({ cls: "lmsa-benchmark-tab-icon" });
      setIcon(iconEl, suite.icon);
    }
    tabBtn.createSpan({ text: suite.name });
    if (suite.id === activeSuiteId) tabBtn.addClass("is-active");

    const contentEl = suitesSection.bodyEl.createDiv({ cls: "lmsa-benchmark-tab-content" });
    if (suite.id !== activeSuiteId) contentEl.addClass("lmsa-hidden");

    contentEl.createEl("p", {
      cls: "lmsa-settings-section-desc",
      text: suite.description,
    });

    const isEmpty = suite.testCases.length === 0;

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

      if (tc.criteria) {
        renderCriteria(detailsEl, tc.criteria);
      }
      renderConversationPreview(detailsEl, tc.messages);

      const resultsContainerEl = detailsEl.createDiv({ cls: "lmsa-benchmark-results-container" });

      toggleBtn.addEventListener("click", () => {
        const visible = !detailsEl.hasClass("lmsa-hidden");
        detailsEl.toggleClass("lmsa-hidden", visible);
        toggleIcon.empty();
        setIcon(toggleIcon, visible ? "chevron-down" : "chevron-up");
      });

      runBtn.addEventListener("click", () => {
        if (isRunning || !selectedModel) return;
        reportIfRejected(runSingleTest(tc), "Failed to run the benchmark test.");
      });

      cardEls.set(tc.id, { statusEl, progressEl, detailsEl, resultsContainerEl, runBtn, toggleBtn });
    }

    const summaryEl = contentEl.createDiv({ cls: "lmsa-benchmark-summary" });
    if (isEmpty) {
      summaryEl.addClass("lmsa-hidden");
    } else {
      summaryEl.setText("Run tests to see results.");
    }

    suiteRefs.set(suite.id, { tabBtn, contentEl, cardEls, summaryEl, runSuiteBtn });

    tabBtn.addEventListener("click", () => {
      if (suite.id === activeSuiteId) return;
      switchToSuite(suite.id);
    });

    runSuiteBtn.addEventListener("click", () => {
      if (isRunning || !selectedModel) return;
      reportIfRejected(runSuite(suite), "Failed to run the benchmark suite.");
    });
  }

  // Cross-suite summary, hidden until there is progress or results to show,
  // so it doesn't duplicate the per-suite placeholder.
  const globalSummaryEl = suitesSection.bodyEl.createDiv({
    cls: "lmsa-benchmark-summary lmsa-hidden",
  });

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
  // Progress tracking
  // -----------------------------------------------------------------------

  let globalCompletedIterations = 0;
  let globalTotalIterations = 0;

  /** Iteration durations of the current run, for pace assessment. */
  let runDurations: number[] = [];

  function resetPaceTracking(): void {
    runDurations = [];
    paceWarningEl.addClass("lmsa-hidden");
  }

  /** Shows the slow-model warning once the run's iterations trend slow. */
  function trackIterationPace(durationMs: number): void {
    runDurations.push(durationMs);
    const pace = assessPace(runDurations);
    if (!pace.slow) return;
    paceWarningTextEl.setText(
      `Iterations are averaging ${(pace.avgMs / 1000).toFixed(1)}s with this model. ${PACE_ADVICE}`
    );
    paceWarningEl.removeClass("lmsa-hidden");
  }

  // -----------------------------------------------------------------------
  // Execution helpers
  // -----------------------------------------------------------------------

  function setRunningState(running: boolean): void {
    isRunning = running;
    runAllBtn.toggleClass("is-disabled", running);
    exportBtn.toggleClass("is-disabled", running);
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

    const tc = allTestCases.find((t) => t.id === testId);
    renderCardStatus(refs.statusEl, result, tc?.isControl ?? false);
    refs.progressEl.addClass("lmsa-hidden");
    renderCardResults(refs.resultsContainerEl, result);
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

  function refreshSuiteSummary(suite: BenchmarkTestSuite): void {
    const refs = suiteRefs.get(suite.id);
    if (!refs) return;
    const stats = computeSuiteSummary(suite.testCases, results);
    renderSuiteSummary(refs.summaryEl, stats);
  }

  function refreshGlobalSummary(): void {
    if (isRunning && globalTotalIterations > 0) {
      globalSummaryEl.removeClass("lmsa-hidden");
      renderProgressSummary(globalSummaryEl, globalCompletedIterations, globalTotalIterations);
      return;
    }
    const stats = computeSummaryStats(allTestCases, results);
    if (stats.totalTests === 0) {
      globalSummaryEl.addClass("lmsa-hidden");
      return;
    }
    globalSummaryEl.removeClass("lmsa-hidden");
    renderSummary(globalSummaryEl, stats, "All suites");
  }

  function setCardError(testId: string, aborted: boolean, message?: string): void {
    const refs = getCardRefs(testId);
    if (refs) {
      refs.statusEl.empty();
      refs.progressEl.addClass("lmsa-hidden");
      refs.statusEl.removeClass("is-running", "is-passed", "is-mixed");
      refs.statusEl.addClass("is-failed");
      refs.statusEl.setText(aborted ? "Aborted" : "Error");
      if (message) refs.statusEl.setAttr("title", message);
    }
  }

  // -----------------------------------------------------------------------
  // Run conditions, history & export
  // -----------------------------------------------------------------------

  /** Sampling params for a run: profile fields + the model's per-model reasoning entry. */
  function samplingFor(model: CompletionModel, profile: ProviderProfile): SamplingParams {
    return buildSamplingParams(
      profile,
      resolveModelReasoning(
        plugin.settings.reasoningByModelKey,
        model,
        plugin.services.modelAvailability,
      ),
    );
  }

  function buildRunConditions(model: CompletionModel, profile: ProviderProfile): BenchmarkRunConditions {
    return {
      provider: model.provider,
      modelId: model.modelId,
      modelName: model.name,
      profileName: profile.name,
      samplingParams: samplingFor(model, profile),
      pluginVersion: plugin.manifest.version,
      timestamp: Date.now(),
      iterationCount,
    };
  }

  /** Collects current results into report sections, optionally limited to the given test IDs. */
  function collectSections(testIds?: Set<string>): SuiteReportSection[] {
    return suites
      .map((suite) => ({
        suiteId: suite.id,
        suiteName: suite.name,
        results: suite.testCases.flatMap((tc) => {
          if (testIds && !testIds.has(tc.id)) return [];
          const result = results.get(tc.id);
          return result ? [{ result, isControl: tc.isControl ?? false }] : [];
        }),
      }))
      .filter((section) => section.results.length > 0);
  }

  /** Persists a condensed history entry for a completed (non-aborted) suite or full run. */
  async function persistHistory(conditions: BenchmarkRunConditions, testIds: Set<string>): Promise<void> {
    const entry = buildHistoryEntry(conditions, collectSections(testIds));
    if (entry.results.length === 0) return;
    const history = plugin.settings.benchmark.history;
    history.unshift(entry);
    if (history.length > MAX_BENCHMARK_HISTORY) history.length = MAX_BENCHMARK_HISTORY;
    await plugin.saveSettings();
  }

  /** Surfaces the first request error of a run as a Notice (cards show the rest). */
  function maybeNoticeError(result: BenchmarkRunResult): void {
    if (!result.error || errorNoticedThisRun) return;
    errorNoticedThisRun = true;
    new Notice(`Benchmark test "${result.testName}" failed: ${result.error}`);
  }

  async function exportReport(): Promise<void> {
    if (isRunning) return;
    if (results.size === 0 || !lastRunConditions) {
      new Notice("Run benchmarks before exporting a report.");
      return;
    }
    const content = buildBenchmarkReport(
      lastRunConditions,
      collectSections(),
      plugin.settings.benchmark.history,
    );
    try {
      const file = await writeBenchmarkReport(
        plugin.app,
        plugin.settings.benchmark.reportFolder,
        buildReportFileName(lastRunConditions),
        content,
      );
      new Notice(`Benchmark report saved to ${file.path}`);
    } catch (err) {
      new Notice(`Could not save benchmark report: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  exportBtn.addEventListener("click", () => {
    void exportReport();
  });

  // -----------------------------------------------------------------------
  // Run handlers
  // -----------------------------------------------------------------------

  /**
   * Refuses to start a run against a local model that isn't already loaded,
   * mirroring the chat send guard (ChatGenerationOrchestrator.generateResponse).
   * A benchmark request would otherwise make LM Studio just-in-time load the
   * model, an action the user never took themselves. `refreshAvailability`
   * probes via a non-loading listing call; cloud models report "loaded"-equivalent
   * "cloud" and always pass.
   */
  async function ensureModelLoaded(): Promise<boolean> {
    const state = await selector.refreshAvailability();
    if (state === "loaded" || state === "cloud") return true;
    selector.retriggerAttention();
    new Notice(
      "The selected model isn't loaded. Load it in LM Studio before running benchmarks, the plugin won't load it for you."
    );
    return false;
  }

  async function runSingleTest(tc: BenchmarkTestCase): Promise<void> {
    if (!selectedModel) return;
    if (!(await ensureModelLoaded())) return;
    setRunningState(true);
    abortController = new AbortController();
    errorNoticedThisRun = false;
    resetPaceTracking();

    globalCompletedIterations = 0;
    globalTotalIterations = iterationCount;

    setCardRunning(tc.id);
    refreshGlobalSummary();

    const suite = findSuiteForTest(tc.id);

    try {
      const client = createChatClient(selectedModel.provider, plugin.settings.providerSettings);
      const profile = getActiveProfile(plugin.settings, selectedModel.provider);
      lastRunConditions = buildRunConditions(selectedModel, profile);
      const result = await runBenchmarkTest(
        client,
        selectedModel,
        tc,
        iterationCount,
        samplingFor(selectedModel, profile),
        (_testId, iter) => {
          trackIterationPace(iter.durationMs);
          globalCompletedIterations++;
          updateCardProgress(tc.id, globalCompletedIterations, iterationCount);
          refreshGlobalSummary();
        },
        abortController.signal,
        profile.anthropicCacheSettings,
      );
      updateCard(tc.id, result);
      maybeNoticeError(result);
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      setCardError(tc.id, aborted, aborted ? undefined : String(err instanceof Error ? err.message : err));
    } finally {
      abortController = null;
      setRunningState(false);
      if (suite) refreshSuiteSummary(suite);
      refreshGlobalSummary();
    }
  }

  async function runSuite(suite: BenchmarkTestSuite): Promise<void> {
    if (!selectedModel) return;
    if (!(await ensureModelLoaded())) return;
    setRunningState(true);
    abortController = new AbortController();
    errorNoticedThisRun = false;
    resetPaceTracking();

    globalCompletedIterations = 0;
    globalTotalIterations = suite.testCases.length * iterationCount;

    const iterTracker = new Map<string, number>();
    for (const tc of suite.testCases) {
      setCardRunning(tc.id);
      iterTracker.set(tc.id, 0);
    }
    refreshGlobalSummary();

    const completedThisRun = new Set<string>();
    try {
      const client = createChatClient(selectedModel.provider, plugin.settings.providerSettings);
      const profile = getActiveProfile(plugin.settings, selectedModel.provider);
      lastRunConditions = buildRunConditions(selectedModel, profile);
      await runAllBenchmarks(
        client,
        selectedModel,
        suite.testCases,
        iterationCount,
        samplingFor(selectedModel, profile),
        (result, _index) => {
          completedThisRun.add(result.testId);
          updateCard(result.testId, result);
          maybeNoticeError(result);
          refreshSuiteSummary(suite);
          refreshGlobalSummary();
        },
        (testId, iter) => {
          trackIterationPace(iter.durationMs);
          const prev = iterTracker.get(testId) ?? 0;
          iterTracker.set(testId, prev + 1);
          updateCardProgress(testId, prev + 1, iterationCount);
          globalCompletedIterations++;
          refreshGlobalSummary();
        },
        abortController.signal,
        profile.anthropicCacheSettings,
      );
      if (abortController.signal.aborted) {
        for (const tc of suite.testCases) {
          if (!completedThisRun.has(tc.id)) setCardError(tc.id, true);
        }
      } else if (lastRunConditions) {
        await persistHistory(lastRunConditions, completedThisRun);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Benchmark run failed: ${message}`);
      for (const tc of suite.testCases) {
        if (!completedThisRun.has(tc.id)) setCardError(tc.id, false, message);
      }
    } finally {
      abortController = null;
      setRunningState(false);
      refreshSuiteSummary(suite);
      refreshGlobalSummary();
    }
  }

  // Run All handler
  runAllBtn.addEventListener("click", voidAsync(async () => {
    if (isRunning || !selectedModel) return;
    if (!(await ensureModelLoaded())) return;
    setRunningState(true);
    abortController = new AbortController();
    errorNoticedThisRun = false;
    resetPaceTracking();

    globalCompletedIterations = 0;
    globalTotalIterations = allTestCases.length * iterationCount;

    const iterTracker = new Map<string, number>();
    for (const tc of allTestCases) {
      setCardRunning(tc.id);
      iterTracker.set(tc.id, 0);
    }
    refreshGlobalSummary();

    const completedThisRun = new Set<string>();
    try {
      const client = createChatClient(selectedModel.provider, plugin.settings.providerSettings);
      const profile = getActiveProfile(plugin.settings, selectedModel.provider);
      lastRunConditions = buildRunConditions(selectedModel, profile);
      for (const suite of suites) {
        if (abortController.signal.aborted) break;
        await runAllBenchmarks(
          client,
          selectedModel,
          suite.testCases,
          iterationCount,
          samplingFor(selectedModel, profile),
          (result, _index) => {
            completedThisRun.add(result.testId);
            updateCard(result.testId, result);
            maybeNoticeError(result);
            refreshSuiteSummary(suite);
            refreshGlobalSummary();
          },
          (testId, iter) => {
            trackIterationPace(iter.durationMs);
            const prev = iterTracker.get(testId) ?? 0;
            iterTracker.set(testId, prev + 1);
            updateCardProgress(testId, prev + 1, iterationCount);
            globalCompletedIterations++;
            refreshGlobalSummary();
          },
          abortController.signal,
          profile.anthropicCacheSettings,
        );
      }
      if (abortController.signal.aborted) {
        for (const tc of allTestCases) {
          if (!completedThisRun.has(tc.id)) setCardError(tc.id, true);
        }
      } else if (lastRunConditions) {
        await persistHistory(lastRunConditions, completedThisRun);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Benchmark run failed: ${message}`);
      for (const tc of allTestCases) {
        if (!completedThisRun.has(tc.id)) setCardError(tc.id, false, message);
      }
    } finally {
      abortController = null;
      setRunningState(false);
      for (const suite of suites) refreshSuiteSummary(suite);
      refreshGlobalSummary();
    }
  }, "Failed to run the benchmarks."));

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

import { setIcon } from "obsidian";
import type WritingAssistantChat from "../main";
import type { CompletionModel, ProviderProfile } from "../shared/types";
import { getProviderDescriptor, createChatClient } from "../providers/registry";
import { PROVIDER_DESCRIPTORS } from "../providers/descriptors";
import { createSettingsSection, createModelSelector, SettingItem } from "./ui";
import { getTestSuites } from "./benchmark/testSuites";
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
    "Choose a completion model to run benchmarks against. The model must be loaded.",
    { icon: "target" }
  );

  if (models.length === 0) {
    modelSection.bodyEl.createEl("p", {
      cls: "lmsa-benchmark-empty",
      text: "No completion models configured. Add one in the completion models tab first.",
    });
    return () => {};
  }

  const modelItem = new SettingItem(modelSection.bodyEl)
    .setName("Completion model")
    .setDesc("The model used to run benchmark tests.");

  const selector = createModelSelector(modelItem.settingEl, models, {
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
        runSingleTest(tc);
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
      runSuite(suite);
    });
  }

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
  // Progress tracking
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
      renderProgressSummary(globalSummaryEl, globalCompletedIterations, globalTotalIterations);
      return;
    }
    const stats = computeSummaryStats(allTestCases, results);
    renderSummary(globalSummaryEl, stats);
  }

  function setCardError(testId: string, aborted: boolean): void {
    const refs = getCardRefs(testId);
    if (refs) {
      refs.statusEl.empty();
      refs.progressEl.addClass("lmsa-hidden");
      refs.statusEl.removeClass("is-running", "is-passed", "is-mixed");
      refs.statusEl.addClass("is-failed");
      refs.statusEl.setText(aborted ? "Aborted" : "Error");
    }
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
    refreshGlobalSummary();

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
          refreshGlobalSummary();
        },
        abortController.signal,
        profile.anthropicCacheSettings,
      );
      updateCard(tc.id, result);
    } catch (err) {
      setCardError(tc.id, err instanceof Error && err.name === "AbortError");
    } finally {
      abortController = null;
      setRunningState(false);
      if (suite) refreshSuiteSummary(suite);
      refreshGlobalSummary();
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
    refreshGlobalSummary();

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
          refreshSuiteSummary(suite);
          refreshGlobalSummary();
        },
        (testId, _iter) => {
          const prev = iterTracker.get(testId) ?? 0;
          iterTracker.set(testId, prev + 1);
          updateCardProgress(testId, prev + 1, iterationCount);
          globalCompletedIterations++;
          refreshGlobalSummary();
        },
        abortController.signal,
        profile.anthropicCacheSettings,
      );
    } catch {
      for (const tc of suite.testCases) {
        if (!results.has(tc.id)) setCardError(tc.id, true);
      }
    } finally {
      abortController = null;
      setRunningState(false);
      refreshSuiteSummary(suite);
      refreshGlobalSummary();
    }
  }

  // Run All handler
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
    refreshGlobalSummary();

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
            refreshSuiteSummary(suite);
            refreshGlobalSummary();
          },
          (testId, _iter) => {
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
    } catch {
      for (const tc of allTestCases) {
        if (!results.has(tc.id)) setCardError(tc.id, true);
      }
    } finally {
      abortController = null;
      setRunningState(false);
      for (const suite of suites) refreshSuiteSummary(suite);
      refreshGlobalSummary();
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

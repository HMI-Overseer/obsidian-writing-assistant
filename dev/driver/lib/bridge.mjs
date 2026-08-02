// The driver's setup-and-readout seam, injected into the renderer (RFC-0013).
//
// It used to be `src/dev/driverBridge.ts`, installed by two compile-time-guarded call sites the
// plugin carried in its own source. It is now injected from here, and the plugin knows nothing
// about it. TypeScript's `private` is erased, so `view.sessionStore`, `view.orchestrator`, and
// `view.interactionHost` are ordinary properties at run time.
//
// Plan decision D3 rejected reaching for exactly one reason: a rename would break the driver
// silently, which is the failure class this instrument exists to remove. That reason is answered
// rather than ignored. {@link assertShape} names every path it depends on and fails the run
// loudly, naming the path it could not find, and it is called immediately after install and
// again the moment the view opens. It is load-bearing, not decoration: without it, this whole
// approach is the silent-drift trap D3 named. A checkpoint predicate that needs a new reach path
// adds it here rather than reaching around the assertion.
//
// The division of labour is unchanged and is still a rule, not a preference:
//
//   Drive through the real UI. Observe and set up through the bridge.
//
// Interaction is real keys and clicks against real DOM. Readout is structured state, because
// scraping rendered DOM is how these harnesses start lying.

export const PLUGIN_ID = "writing-assistant-chat";
export const VIEW_TYPE = "writing-assistant-chat";

/** Ceiling on a checkpoint that has stopped arriving, never a duration anything waits out. */
export const CHECKPOINT_TIMEOUT_MS = 60_000;

/**
 * Defines `window.__lmsaDriver`. Serialized into the page by Playwright, so it closes over
 * nothing but its own argument.
 *
 * Nothing here asserts at definition time, because this also runs as an init script on every
 * navigation, before the plugin exists. Every method asserts when it is called instead, and the
 * driver calls {@link assertShape} explicitly once the plugin has loaded.
 */
function defineBridge({ pluginId, viewType }) {
  const app = () => window.app;
  const plugin = () => window.app?.plugins?.plugins?.[pluginId];
  const chatView = () => {
    const leaves = window.app?.workspace?.getLeavesOfType?.(viewType) ?? [];
    return leaves.length > 0 ? leaves[0].view : null;
  };

  const check = (missing, condition, path) => {
    if (!condition) missing.push(path);
  };

  /**
   * Every reach path this bridge depends on, checked in one pass so a drifted build reports all
   * of them at once instead of one per run.
   *
   * @param requireView whether the chat view is expected to be open.
   */
  const assertShape = (requireView) => {
    const missing = [];
    check(missing, typeof app() === "object" && app() !== null, "window.app");
    check(missing, typeof app()?.workspace?.layoutReady === "boolean", "app.workspace.layoutReady");
    check(
      missing,
      typeof app()?.workspace?.getLeavesOfType === "function",
      "app.workspace.getLeavesOfType",
    );
    check(missing, typeof plugin() === "object" && plugin() !== null, `app.plugins.plugins["${pluginId}"]`);
    check(missing, typeof plugin()?.activateChatView === "function", "plugin.activateChatView");
    // What live mode's model question and its reachability preflight read. Asserted here even on
    // a scripted run, because the bridge depends on them by name either way and one pass that
    // reports every drift beats one that reports whichever path this run happened to take.
    const availability = plugin()?.services?.modelAvailability;
    check(missing, typeof availability?.getAvailability === "function", "plugin.services.modelAvailability.getAvailability");
    check(missing, typeof availability?.refreshLocalModels === "function", "plugin.services.modelAvailability.refreshLocalModels");
    check(missing, typeof availability?.resolveContextWindow === "function", "plugin.services.modelAvailability.resolveContextWindow");

    if (requireView) {
      const view = chatView();
      check(missing, typeof view === "object" && view !== null, `a leaf of type "${viewType}"`);
      check(missing, typeof view?.sessionStore?.getSnapshot === "function", "view.sessionStore.getSnapshot");
      check(missing, typeof view?.orchestrator?.getIsGenerating === "function", "view.orchestrator.getIsGenerating");
      check(missing, typeof view?.interactionHost?.isActive === "function", "view.interactionHost.isActive");
      check(
        missing,
        typeof view?.sessionStore?.getResolvedConversationModel === "function",
        "view.sessionStore.getResolvedConversationModel",
      );
      // The one path that keeps `selectableModels()` honest: it is the same closure the app's own
      // selector calls, so the driver reads through `getSelectableCompletionModels()` rather than
      // composing a second answer to "what models can I pick". See selectableModels below.
      check(
        missing,
        typeof view?.modelSelector?.options?.getModels === "function",
        "view.modelSelector.options.getModels",
      );
    }

    if (missing.length > 0) {
      throw new Error(
        `dev/driver bridge: the plugin no longer exposes ${missing.join(", ")}. ` +
          `The driver reaches for these by name, so a rename lands here. ` +
          `Fix dev/driver/lib/bridge.mjs.`,
      );
    }
    return true;
  };

  /**
   * The plugin's own revision selection, in four lines.
   *
   * It reads the persisted conversation shape, which the run directory writes out wholesale
   * anyway, rather than any private plumbing, so it drifts only if the stored format changes,
   * and a changed stored format is a finding the transcript itself would carry.
   */
  const activeRevision = (message) => {
    if (message.role !== "assistant" || !message.revisions || !message.activeRevisionId) {
      return null;
    }
    return message.revisions.find((r) => r.revisionId === message.activeRevisionId) ?? null;
  };

  /** The active turn of one message, asserted rather than coerced when the shape has drifted. */
  const turnOf = (message) => {
    const revision = activeRevision(message);
    if (!revision || revision.kind !== "turn") return null;
    if (typeof revision.turn?.status !== "string") {
      throw new Error(
        "dev/driver bridge: an assistant revision of kind \"turn\" has no readable turn.status. " +
          "The turn-started and turn-settled checkpoints read it. Fix dev/driver/lib/bridge.mjs.",
      );
    }
    return revision.turn;
  };

  /**
   * One turn item, as much of it as a reader needs to reach a verdict without the app.
   *
   * Stage 1 reported a tool step as its name and its lifecycle state, which says a step happened
   * and nothing about what it did. A maintainer judging "prose, then a tool step, then more
   * prose" has to see the arguments it ran with and the result it came back with, and a
   * declined approval is only judgeable from the guidance that rode back on the result. All of
   * it is already on the persisted item; none of it is new plumbing.
   */
  const summarizeItem = (item) => {
    if (item.type === "prose") return { type: "prose", label: item.text };
    return {
      type: "tool_call",
      label: item.toolName,
      state: item.state,
      ...(item.toolArguments ? { arguments: item.toolArguments } : {}),
      // The digest when the tool has one, the bounded record otherwise. `read` and the
      // other path-to-content tools deliberately carry no digest (their arguments are the
      // pointer), so reading only the digest would show a tool step with no result at all,
      // which is the half of a tool step a verdict actually turns on.
      ...(item.resultDigest || item.resultRecord
        ? { result: item.resultDigest ?? item.resultRecord }
        : {}),
      ...(item.isError === true ? { isError: true } : {}),
      ...(item.errorContent ? { error: item.errorContent } : {}),
      ...(item.askStatus ? { askStatus: item.askStatus } : {}),
    };
  };

  const summarizeTurn = (messages) => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const turn = turnOf(messages[index]);
      if (!turn) continue;
      return turn.items.map(summarizeItem);
    }
    return [];
  };

  const unreadable = (path) =>
    new Error(
      `dev/driver bridge: the composer interaction lane is occupied but ${path} is unreadable. ` +
        `Fix dev/driver/lib/bridge.mjs.`,
    );

  /**
   * The active interaction: its kind, and the substance it is asking about.
   *
   * Stage 0 could only report a boolean, because `ComposerInteractionHost.active` is private and
   * the bridge lived inside the typechecked source. Reaching from outside reads it directly, so
   * `approval-raised` and `ask-raised` need no production accessor added for the driver's
   * benefit.
   *
   * The request itself is read for the same reason the turn items are: a screenshot of a raised
   * approval says a drawer is open, and the review sheet has to be able to say *what* it is
   * asking to do. `summary` and `detail` are the two derived lines the drawer itself renders,
   * so nothing here can name a change in words the app does not.
   *
   * These are new reach paths, and they follow the rule the kind already follows: assert exactly
   * when it matters, which is when the lane is occupied. `assertShape()` cannot cover them,
   * because at the moment it runs there is nothing mounted to read.
   */
  const interactionSummary = (host) => {
    if (!host.isActive()) return null;
    const interaction = host.active?.interaction;
    const kind = interaction?.kind;
    if (typeof kind !== "string") throw unreadable("interactionHost.active.interaction.kind");

    const request = interaction.request;
    if (kind === "approval") {
      if (typeof request?.summary !== "string") {
        throw unreadable("interactionHost.active.interaction.request.summary");
      }
      return {
        kind,
        channel: request.channel ?? null,
        summary: request.summary,
        detail: request.detail ?? null,
      };
    }
    if (kind === "ask") {
      if (!Array.isArray(request?.questions)) {
        throw unreadable("interactionHost.active.interaction.request.questions");
      }
      return {
        kind,
        questions: request.questions.map((question) => ({
          header: question.header,
          question: question.question,
          options: (question.options ?? []).map((option) => option.label),
          multiSelect: question.multiSelect === true,
        })),
      };
    }
    // A third kind would be a real addition to the drawer, and reporting it as an unlabelled
    // interaction beats inventing a shape for it.
    return { kind };
  };

  /**
   * One model, with what the app has discovered about it.
   *
   * Capabilities come from `ModelAvailabilityService`, which is where the app itself reads them:
   * `state` is what the availability dot beside the model name shows, and the rest is what the
   * capacity ring, the tool-use indicator, and the reasoning selector read. A live run records
   * these so the artifact says what executed rather than what was asked for.
   */
  const describeModel = (model, availability) => {
    const info = availability.getAvailability(model.modelId, model.provider);
    return {
      key: model.id,
      name: model.name,
      modelId: model.modelId,
      provider: model.provider,
      state: info.state,
      contextWindow: availability.resolveContextWindow(model) ?? null,
      trainedForToolUse: info.trainedForToolUse ?? null,
      vision: info.vision ?? null,
      reasoning: info.reasoning?.allowedOptions ?? null,
    };
  };

  // ─── what a checkpoint reads ──────────────────────────────────────────────────────────────
  //
  // `interactionsSeen` is the one figure here that is not a plain read of the moment. The
  // composer's interaction lane is single-slot and empties on submit, so "the interaction was
  // submitted" is indistinguishable from "there has not been one yet" by looking at the lane
  // alone. Counting raises as they are sampled makes the two distinguishable without wrapping
  // any of the application's own methods, which plan decision D12 holds in reserve.
  //
  // It is sampled, so it inherits D4's edge-blindness: an interaction raised and answered
  // between two samples is not counted. That is the accepted cost, not a hidden one.

  let interactionsSeen = 0;
  let lastSampledKind = null;

  const sampleInteractions = (kind) => {
    if (kind !== null && lastSampledKind === null) interactionsSeen += 1;
    lastSampledKind = kind;
    return interactionsSeen;
  };

  const signals = () => {
    const view = chatView();
    const readout = {
      pluginLoaded: typeof plugin() === "object" && plugin() !== null,
      layoutReady: app()?.workspace?.layoutReady === true,
      viewOpen: false,
      generating: false,
      messageCount: 0,
      interactionActive: false,
      interactionKind: null,
      interaction: null,
      interactionsSeen,
      settledTurns: 0,
      settledTurnKey: "",
      turnStatus: null,
      scriptId: globalThis.__lmsaDriverScript?.id ?? null,
    };

    if (!view || typeof view.sessionStore?.getSnapshot !== "function") {
      sampleInteractions(null);
      readout.interactionsSeen = interactionsSeen;
      return readout;
    }

    const messages = view.sessionStore.getSnapshot().messageHistory;
    const settledRevisionIds = [];
    let turnStatus = null;
    for (const message of messages) {
      const revision = activeRevision(message);
      const turn = turnOf(message);
      if (!turn) continue;
      turnStatus = turn.status;
      if (turn.status !== "streaming") settledRevisionIds.push(revision.revisionId);
    }

    const interaction = interactionSummary(view.interactionHost);
    readout.viewOpen = true;
    readout.generating = view.orchestrator.getIsGenerating();
    readout.messageCount = messages.length;
    readout.interactionActive = view.interactionHost.isActive();
    readout.interaction = interaction;
    readout.interactionKind = interaction?.kind ?? null;
    readout.interactionsSeen = sampleInteractions(readout.interactionKind);
    readout.settledTurns = settledRevisionIds.length;
    // Which settlements these are, not merely how many. A regeneration replaces the active
    // revision of the message it settled, so the count is identical before and after and a
    // predicate over the count alone can never see one happen. The ids are already in the
    // transcript this reads; nothing new is asked of the plugin.
    readout.settledTurnKey = settledRevisionIds.join("|");
    readout.turnStatus = turnStatus;
    return readout;
  };

  // ─── the checkpoint registry ──────────────────────────────────────────────────────────────
  //
  // Per plan decision D4 a checkpoint is a predicate, re-evaluated on change, not an emitted
  // event: there is no event bus in the plugin and adding one would put driver-motivated code in
  // production paths. A predicate has no duration, so this is not the "sleep and hope" the RFC
  // rejects; what it is instead is edge-blind, and every name below is a state that persists
  // rather than a moment that passes.
  //
  // `baseline` is the readout at the moment the wait began. Two of these are only meaningful
  // against a starting point: "settled" and "started" both describe a change, and a level
  // predicate alone would report the previous turn's settlement as this one's.
  //
  // Stage 2 amended what "a different settlement" means, and the amendment is still a read.
  // Counting settled turns cannot see a regeneration: it replaces the active revision of a
  // message that already counted, so the count is one before and one after, and `turn-settled`
  // would wait out its whole timeout on a turn that had finished. Comparing *which* revisions
  // are settled sees it, needs nothing from the plugin, and leaves D12's reserve unspent: this
  // reads state the transcript already carries rather than wrapping any method.

  const CHECKPOINTS = {
    "plugin-ready": (now) => now.pluginLoaded && now.layoutReady,
    "view-open": (now) => now.viewOpen,
    "turn-started": (now, baseline) =>
      now.generating || now.settledTurnKey !== baseline.settledTurnKey,
    "approval-raised": (now) => now.interactionKind === "approval",
    "ask-raised": (now) => now.interactionKind === "ask",
    "interaction-submitted": (now) => now.interactionsSeen > 0 && now.interactionKind === null,
    "turn-settled": (now, baseline) =>
      !now.generating && now.settledTurnKey !== baseline.settledTurnKey,
  };

  /**
   * The RFC's candidates that this instrument cannot honestly observe, with the reason.
   *
   * Asking for one is a loud, specific failure rather than "unknown checkpoint", because the
   * gap is a finding about the plugin's observability and a scenario author meeting it should
   * read why rather than guess at a spelling.
   */
  const UNAVAILABLE = {
    "frame-published": {
      reason:
        "transient: a published frame does not persist, and a predicate re-evaluated on change " +
        "is edge-blind (D4, D12). Wait on turn-settled and read the prose from state().",
    },
    "tool-step-rendered": {
      reason:
        "transient when a step completes inside one evaluation window (D4, D12). Wait on " +
        "turn-settled and read the step from state().turnItems, which is weaker and is stated " +
        "as weaker.",
    },
    "run-quiesced": {
      reason:
        "unreachable: TurnRunOwner.isQuiet lives on a local const inside the tool loop that no " +
        "object the view holds exposes, so reaching from outside does not help. The turn's own " +
        "quiescence is in the transcript once it settles.",
    },
  };

  // ─── the engine ───────────────────────────────────────────────────────────────────────────

  const waiters = new Set();
  let observer = null;
  let backstop = null;
  let scheduled = false;

  const evaluate = () => {
    const now = signals();
    for (const waiter of [...waiters]) {
      let arrived = false;
      try {
        arrived = waiter.predicate(now, waiter.baseline) === true;
      } catch (error) {
        waiters.delete(waiter);
        waiter.settle(() => waiter.reject(error));
        continue;
      }
      if (arrived) {
        waiters.delete(waiter);
        waiter.settle(() => waiter.resolve(now));
      }
    }
  };

  // Mutations arrive in bursts while a turn streams, and a burst says no more than its first
  // record does. Coalescing to one evaluation per task keeps the observer from turning a
  // streaming turn into thousands of transcript walks.
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      evaluate();
    });
  };

  /**
   * Starts observing, once, on the first wait.
   *
   * The plan names the view's container as the observation target. The first two checkpoints
   * exist precisely because the view is not open yet, so the target is the document instead;
   * its subtree contains the view once it appears, which means one observer with no re-targeting
   * and nothing that can be missed while the target is being swapped.
   *
   * The backstop interval is not a cadence anything waits out. It exists because state can also
   * change without touching the DOM, and it decides only how often a predicate is re-asked.
   */
  const ensureEngine = () => {
    if (observer) return;
    const target = document.body ?? document.documentElement;
    observer = new MutationObserver(schedule);
    observer.observe(target, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    backstop = window.setInterval(schedule, 250);
  };

  /**
   * @param baseline the readout to compare against, or null to sample one now.
   *
   * A caller supplies one because "the state when the wait began" is the wrong reference point
   * whenever anything happens between the action and the wait. Pause mode is where that stopped
   * being theoretical: a breakpoint at a shot taken mid-turn hands the app over, the turn settles
   * while it is being looked at, and a `turn-settled` that sampled its own baseline afterwards is
   * asking whether the settlement it can already see is different from itself. It never is, so
   * the wait runs to its ceiling in silence. The reference point a scenario means is the state
   * *before the action it took*, and `scenarioApi` captures exactly that.
   */
  const awaitCheckpoint = (name, timeoutMs, baseline = null) => {
    const unavailable = UNAVAILABLE[name];
    if (unavailable) {
      return Promise.reject(
        new Error(`Checkpoint "${name}" is unavailable. ${unavailable.reason}`),
      );
    }
    const predicate = CHECKPOINTS[name];
    if (!predicate) {
      return Promise.reject(
        new Error(
          `Unknown checkpoint "${name}". This driver ships ` +
            `${Object.keys(CHECKPOINTS).join(", ")}.`,
        ),
      );
    }

    ensureEngine();
    const before = baseline ?? signals();
    return new Promise((resolve, reject) => {
      let done = false;
      const settle = (act) => {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        act();
      };
      const waiter = { predicate, baseline: before, resolve, reject, settle };
      const timer = window.setTimeout(() => {
        waiters.delete(waiter);
        settle(() =>
          reject(
            new Error(
              `Checkpoint "${name}" did not arrive within ${timeoutMs}ms. ` +
                `The state it was asked about: ${JSON.stringify(signals())}.`,
            ),
          ),
        );
      }, timeoutMs);

      waiters.add(waiter);
      // Evaluated immediately as well as on change, so a checkpoint that is already true when
      // the wait begins arrives at once instead of waiting for the next mutation.
      evaluate();
    });
  };

  window.__lmsaDriver = {
    assertShape,

    /** Opens the view through the `open-chat` command's own callback body. */
    async openChat() {
      assertShape(false);
      await plugin().activateChatView();
      assertShape(true);
    },

    /**
     * Arms the scripted provider for every subsequent generation.
     *
     * The script has already been validated in Node, before anything launched. This only refuses
     * the case where the bundle carries no epilogue to arm, which would otherwise send a real
     * request with a placeholder key.
     */
    arm(script) {
      if (globalThis.__lmsaDriverEpilogue !== true) {
        throw new Error(
          "dev/driver bridge: the installed main.js carries no driver epilogue, so no scripted " +
            "provider can be armed. Seed with a script, or run without one.",
        );
      }
      globalThis.__lmsaDriverScript = script;
    },

    disarm() {
      globalThis.__lmsaDriverScript = null;
    },

    /**
     * What the app itself would offer in its model selector, with discovered capabilities.
     *
     * `src/providers/selectableModels.ts` states the invariant that every "what models can I
     * pick" consumer reads through `getSelectableCompletionModels()`, or provider enablement
     * becomes advisory and a disabled provider's models leak into selection. The driver's picker
     * is one more consumer and gets no exception, so this reaches the **selector's own closure**
     * rather than composing a second answer from settings. If that closure moves, `assertShape()`
     * says so by name.
     *
     * The refresh is not decoration either. For LM Studio, `getSelectableCompletionModels()`
     * reads `lmStudioModelCache`, which is a *last-seen* cache: without a discovery pass the list
     * is whatever was true the last time somebody looked, and a model can be in it and not be
     * loaded, or be loaded and not be in it. This is the same refresh the dropdown runs when it
     * opens. A discovery failure is reported rather than thrown, because "LM Studio is not
     * answering" is a plain reason the picker should print, not a stack trace.
     */
    async selectableModels() {
      assertShape(true);
      const availability = plugin().services.modelAvailability;
      let discoveryError = null;
      try {
        await availability.refreshLocalModels({ forceRefresh: true });
      } catch (error) {
        discoveryError = error instanceof Error ? error.message : String(error);
      }
      const models = chatView()
        .modelSelector.options.getModels()
        .map((model) => describeModel(model, availability));
      return { models, discoveryError };
    },

    awaitCheckpoint,

    /**
     * The readout a following checkpoint compares against.
     *
     * Cheaper than `state()` on purpose: no transcript, no turn items. A scenario takes one of
     * these before every action it performs, and it is what makes a predicate mean "changed since
     * I clicked" rather than "changed since I started looking".
     */
    baseline() {
      return signals();
    },

    /** What this build can and cannot observe, for the manifest. */
    checkpoints() {
      return {
        available: Object.keys(CHECKPOINTS),
        unavailable: Object.entries(UNAVAILABLE).map(([name, entry]) => ({
          name,
          reason: entry.reason,
        })),
      };
    },

    state() {
      const readout = signals();
      if (!readout.viewOpen) return { ...readout, model: null, turnItems: [], messages: [] };
      const view = chatView();
      const snapshot = view.sessionStore.getSnapshot();
      // Read here rather than in `signals()`, which every checkpoint evaluation calls: the model
      // a conversation resolves to changes when somebody selects one, not while a turn streams,
      // and no predicate reads it. What it is for is the read-back after a live run selects a
      // model, so a manifest records what the app resolved rather than what the picker asked for.
      const model = view.sessionStore.getResolvedConversationModel();
      return {
        ...readout,
        model: model ? describeModel(model, plugin().services.modelAvailability) : null,
        turnItems: summarizeTurn(snapshot.messageHistory),
        messages: snapshot.messageHistory,
      };
    },

    /** Stops observing. Used when the driver is done with a page it is leaving running. */
    stopEngine() {
      if (observer) observer.disconnect();
      if (backstop) window.clearInterval(backstop);
      observer = null;
      backstop = null;
    },
  };
}

/**
 * Installs the bridge, twice over: as an init script so it survives a reload the maintainer
 * triggers by hand, and once immediately for the run in progress.
 */
export async function installBridge(page) {
  const args = { pluginId: PLUGIN_ID, viewType: VIEW_TYPE };
  await page.addInitScript(defineBridge, args);
  await page.evaluate(defineBridge, args);
}

/** Fails the run loudly if the plugin no longer exposes what the bridge reaches for. */
export function assertBridgeShape(page, requireView = false) {
  return page.evaluate((withView) => window.__lmsaDriver.assertShape(withView), requireView);
}

export function readState(page) {
  return page.evaluate(() => window.__lmsaDriver.state());
}

/** The comparison point for the next checkpoint. See `awaitCheckpoint`'s baseline parameter. */
export function readBaseline(page) {
  return page.evaluate(() => window.__lmsaDriver.baseline());
}

export function readCheckpointRegistry(page) {
  return page.evaluate(() => window.__lmsaDriver.checkpoints());
}

/** The app's own model list, after a discovery pass. Live mode's picker and preflight read it. */
export function readSelectableModels(page) {
  return page.evaluate(() => window.__lmsaDriver.selectableModels());
}

/** Leaves no observer running inside an app the driver is about to stop recording. */
export function stopEngine(page) {
  return page.evaluate(() => window.__lmsaDriver.stopEngine());
}

/**
 * Waits for a named checkpoint, from Node.
 *
 * The in-page timeout is the one that reports a state; the Node-side ceiling above it exists
 * for the case the in-page timer cannot fire at all, which is a wedged renderer. That case is
 * one of the reasons RFC-0013 chose an external driver over an in-plugin one, so it should not
 * be the one case that hangs.
 */
export async function awaitCheckpoint(
  page,
  name,
  timeoutMs = CHECKPOINT_TIMEOUT_MS,
  baseline = null,
) {
  let wedged = null;
  const stalled = new Promise((_resolve, reject) => {
    wedged = setTimeout(
      () =>
        reject(
          new Error(
            `Checkpoint "${name}" did not arrive within ${timeoutMs}ms, and the renderer did ` +
              `not answer its own timeout either.`,
          ),
        ),
      timeoutMs + 5_000,
    );
  });
  try {
    return await Promise.race([
      page.evaluate(
        ([checkpoint, ms, before]) => window.__lmsaDriver.awaitCheckpoint(checkpoint, ms, before),
        [name, timeoutMs, baseline],
      ),
      stalled,
    ]);
  } finally {
    clearTimeout(wedged);
  }
}

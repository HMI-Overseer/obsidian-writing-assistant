import type WritingAssistantChat from "../main";
import type { ConversationMessage } from "../shared/types";
import type { ChatGenerationOrchestrator } from "../chat/ChatGenerationOrchestrator";
import type { ChatSessionStore } from "../chat/conversation/ChatSessionStore";
import { getActiveAssistantRevision } from "../chat/conversation/assistantRevisions";
import type { ComposerInteractionHostPort } from "../chat/interactions/ComposerInteractionHost";
import type { DriverScript } from "./driverScript";
import { validateDriverScript } from "./driverScript";
import { installScriptedProvider, installedScriptId } from "./scriptedChatClient";

/**
 * The live scenario driver's setup-and-readout seam, on `window.__lmsaDriver` (RFC-0013).
 *
 * The division of labour is a rule, not a preference: **drive through the real UI, observe and
 * set up through the bridge**. Interaction is real keys, clicks, and hover against real DOM,
 * because interaction fidelity is the reason for driving the live app at all. Readout is
 * structured state, because scraping rendered DOM is how these harnesses start lying.
 *
 * Nothing here reaches for state. The view hands the bridge its own members through
 * {@link attachDriverView}, so a rename is a compile error in a typechecked file rather than a
 * silent miss at run time. That is also why there is no `as unknown as` anywhere below: a
 * structural assertion is exactly the failure class this instrument exists to remove.
 *
 * This module has no top-level side effects and imports nothing from `dev/`. The driver knows
 * about the bridge; the bridge knows nothing about the driver.
 */

/** One item of the most recent assistant turn, flattened for readout. */
export interface DriverTurnItem {
  type: "prose" | "tool_call";
  /** Prose text, or the tool name for a tool call. */
  label: string;
  /** Lifecycle state of a tool call; absent on prose. */
  state?: string;
}

export interface DriverState {
  /** The chat view is open and has handed the bridge its readout sources. */
  viewOpen: boolean;
  generating: boolean;
  messageCount: number;
  /**
   * Whether the composer's single interaction lane is occupied. The lane's own `kind` is not
   * reachable without a new production accessor, so it is deliberately absent rather than
   * guessed from DOM. Stage 1 settles it, where `approval-raised` and `ask-raised` land.
   */
  interactionActive: boolean;
  /** The id of the installed scripted script, or null in live mode. */
  scriptId: string | null;
  /** Items of the last assistant message's active turn revision. */
  turnItems: DriverTurnItem[];
  /** The conversation as the plugin holds it, for the run's `transcript.json`. */
  messages: ConversationMessage[];
}

/** What the chat view hands the bridge. Every member is already public on its own object. */
export interface DriverViewSources {
  sessionStore: ChatSessionStore;
  orchestrator: ChatGenerationOrchestrator;
  interactionHost: ComposerInteractionHostPort;
}

export interface DriverBridge {
  /** Resolves once the plugin has loaded and the workspace layout is ready. */
  ready(): Promise<void>;
  /** Opens the chat view through the plugin's own activation path. */
  openChat(): Promise<void>;
  /** Validates a script and installs it for every subsequent generation. */
  useScriptedProvider(script: unknown, id: string): void;
  state(): DriverState;
}

declare global {
  interface Window {
    __lmsaDriver?: DriverBridge;
  }
}

let viewSources: DriverViewSources | null = null;

function summarizeTurn(messages: ConversationMessage[]): DriverTurnItem[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const revision = getActiveAssistantRevision(messages[index]);
    if (!revision || revision.kind !== "turn") continue;
    return revision.turn.items.map((item) =>
      item.type === "prose"
        ? { type: "prose", label: item.text }
        : { type: "tool_call", label: item.toolName, state: item.state },
    );
  }
  return [];
}

function readState(): DriverState {
  const sources = viewSources;
  if (!sources) {
    return {
      viewOpen: false,
      generating: false,
      messageCount: 0,
      interactionActive: false,
      scriptId: installedScriptId(),
      turnItems: [],
      messages: [],
    };
  }

  const snapshot = sources.sessionStore.getSnapshot();
  return {
    viewOpen: true,
    generating: sources.orchestrator.getIsGenerating(),
    messageCount: snapshot.messageHistory.length,
    interactionActive: sources.interactionHost.isActive(),
    scriptId: installedScriptId(),
    turnItems: summarizeTurn(snapshot.messageHistory),
    messages: snapshot.messageHistory,
  };
}

/**
 * Installs the bridge. Called from `onload()` behind `if (DEV_DRIVER)`, so a release artifact
 * has neither the call nor this module.
 */
export function installDriverBridge(plugin: WritingAssistantChat): void {
  const bridge: DriverBridge = {
    ready: () =>
      new Promise<void>((resolve) => {
        plugin.app.workspace.onLayoutReady(() => resolve());
      }),
    // The `open-chat` command's own callback body. Going through the command registry would
    // need an assertion over Obsidian's untyped internals for no observable difference.
    openChat: () => plugin.activateChatView(),
    useScriptedProvider: (script: unknown, id: string) => {
      const validated: DriverScript = validateDriverScript(script, id);
      installScriptedProvider(validated);
    },
    state: readState,
  };

  window.__lmsaDriver = bridge;
  plugin.register(() => {
    delete window.__lmsaDriver;
    installScriptedProvider(null);
    viewSources = null;
  });
}

/**
 * Hands the bridge the view's own readout sources. Called at the end of `ChatView.onOpen()`
 * behind `if (DEV_DRIVER)`.
 */
export function attachDriverView(sources: DriverViewSources): void {
  viewSources = sources;
}

/** Drops the readout sources when the view closes. */
export function detachDriverView(): void {
  viewSources = null;
}

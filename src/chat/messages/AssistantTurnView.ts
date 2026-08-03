import { type App, setIcon } from "obsidian";
import type {
  AssistantTurnRecord,
  ToolActionLedgerEntry,
} from "../../shared/types";
import type {
  AssistantTurnSnapshot,
} from "../turns/AssistantTurnBuilder";
import type { MarkdownBubbleRenderer } from "../rendering/MarkdownBubbleRenderer";
import type { ActionControlEligibility } from "../conversation/actionLedger";
import { isMutatingTool, toolIcon } from "../../tools/metadata";
import {
  AssistantActionHostCoordinator,
  AssistantTurnItemHostRegistry,
  type AssistantActionView,
  type AssistantTurnItemHost,
} from "./AssistantTurnItemHostRegistry";
import { AssistantTurnRenderSequencer } from "./AssistantTurnRenderSequencer";
import {
  buildAssistantTurnRenderModel,
  buildLegacyAssistantRenderModel,
  planAssistantTurnRenderUpdate,
  type AssistantTurnRenderItem,
  type AssistantTurnRenderModel,
  type AssistantTurnToolRenderItem,
  type LegacyAssistantRenderSource,
} from "./assistantTurnRenderModel";
import type { RegexEditPreview } from "./regexEditPreview";
import {
  buildActionLedgerReviewModel,
  type ActionReviewControl,
} from "./actionLedgerReview";
import { ActionLedgerEvidenceView } from "./ActionLedgerEvidenceView";

export interface AssistantTurnViewRefreshOptions {
  actionLedger?: readonly ToolActionLedgerEntry[];
  errorMessage?: string;
  regexEditPreview?: RegexEditPreview | null;
}

interface ItemViewState {
  type: AssistantTurnRenderItem["type"];
  itemEl: HTMLLIElement;
  markerEl: HTMLElement;
  contentEl: HTMLElement;
  actionEl: HTMLElement;
  renderedText?: string;
  requestedText?: string;
  tool?: ToolItemRefs;
  destroy(): void;
}

interface ToolItemRefs {
  toolSummaryEl: HTMLElement;
  nameEl: HTMLElement;
  detailEl: HTMLElement;
  askEl: HTMLElement;
  diagnosticsEl: HTMLElement;
  expanded: boolean;
  hasDisclosure: boolean;
}

const ITEM_STATE_CLASSES = [
  "is-declared",
  "is-running",
  "is-completed",
  "is-interrupted",
  "is-failed",
  "is-mutating",
];

/**
 * One ordered projection over a live assistant snapshot or frozen turn record.
 *
 * Item hosts are keyed by stable domain item ID. Markdown, tool lifecycle, and
 * action placement update those hosts without reconstructing a second turn.
 */
export class AssistantTurnView {
  readonly rootEl: HTMLElement;
  readonly registry = new AssistantTurnItemHostRegistry();

  private readonly listEl: HTMLOListElement;
  private readonly emptyEl: HTMLElement;
  private readonly emptyMarkerEl: HTMLElement;
  private readonly emptyLabelEl: HTMLElement;
  private readonly noticeEl: HTMLElement;
  private readonly regexPreviewEl: HTMLElement;
  private readonly provisionalSectionEl: HTMLElement;
  private readonly provisionalHostEl: HTMLElement;
  private readonly auditSectionEl: HTMLElement;
  private readonly auditHostEl: HTMLElement;
  private readonly actionCoordinator: AssistantActionHostCoordinator;
  private readonly renderSequencer = new AssistantTurnRenderSequencer();
  private readonly itemStates = new Map<string, ItemViewState>();
  private readonly pendingRenders = new Set<Promise<void>>();
  private itemOrder: string[] = [];
  private renderItems = new Map<string, AssistantTurnRenderItem>();
  private actionLedger: readonly ToolActionLedgerEntry[] = [];
  private getActionEligibility: (
    entry: ToolActionLedgerEntry,
    targetId: string,
  ) => ActionControlEligibility = () => NO_ACTION_ELIGIBILITY;
  private onActionControl: (
    entry: ToolActionLedgerEntry,
    targetId: string,
    control: ActionReviewControl,
  ) => void = () => undefined;
  private destroyed = false;

  constructor(
    containerEl: HTMLElement,
    private readonly app: App,
    private readonly markdownRenderer: MarkdownBubbleRenderer,
    private readonly onContentChanged: () => void = () => undefined,
  ) {
    this.rootEl = containerEl.createDiv({
      cls: "lmsa-assistant-turn",
    });
    this.listEl = this.rootEl.createEl("ol", {
      cls: "lmsa-assistant-turn-list",
    });
    this.emptyEl = this.rootEl.createDiv({
      cls: "lmsa-assistant-turn-empty lmsa-hidden",
    });
    this.emptyMarkerEl = this.emptyEl.createSpan({
      cls: "lmsa-assistant-turn-empty-marker",
      attr: { "aria-hidden": "true" },
    });
    this.emptyLabelEl = this.emptyEl.createSpan({
      cls: "lmsa-assistant-turn-empty-label",
    });
    this.noticeEl = this.rootEl.createDiv({
      cls: "lmsa-assistant-turn-notice lmsa-hidden",
    });
    this.regexPreviewEl = this.rootEl.createDiv({
      cls: "lmsa-assistant-turn-regex-preview lmsa-hidden",
    });
    this.provisionalSectionEl = this.createActionSection(
      "lmsa-assistant-turn-provisional",
      "Review awaiting declaration",
      "Pending review that has not received an ordered provider declaration",
    );
    this.provisionalHostEl = this.provisionalSectionEl.createDiv({
      cls: "lmsa-assistant-turn-message-actions",
    });
    this.auditSectionEl = this.createActionSection(
      "lmsa-assistant-turn-audit",
      "Unplaced action audit",
      "Action history without a correlated provider declaration",
    );
    this.auditHostEl = this.auditSectionEl.createDiv({
      cls: "lmsa-assistant-turn-message-actions",
    });
    this.actionCoordinator = new AssistantActionHostCoordinator(
      this.registry,
      this.provisionalHostEl,
      this.auditHostEl,
      (entry) =>
        new ActionLedgerEntryView(
          entry,
          this.rootEl,
          this.app,
          (currentEntry, targetId) =>
            this.getActionEligibility(currentEntry, targetId),
          (currentEntry, targetId, control) =>
            this.onActionControl(currentEntry, targetId, control),
        ),
    );
  }

  async refresh(
    turn: AssistantTurnSnapshot | AssistantTurnRecord,
    options: AssistantTurnViewRefreshOptions = {},
  ): Promise<void> {
    this.assertActive();
    const model = buildAssistantTurnRenderModel(turn, {
      errorMessage: options.errorMessage,
    });
    await this.refreshModel(
      model,
      options.actionLedger ?? [],
      options.regexEditPreview ?? null,
    );
  }

  async refreshLegacy(
    source: LegacyAssistantRenderSource,
    actionLedger: readonly ToolActionLedgerEntry[] = [],
  ): Promise<void> {
    this.assertActive();
    await this.refreshModel(
      buildLegacyAssistantRenderModel(source),
      actionLedger,
      null,
    );
  }

  getReviewItemForActionRef(actionRef: string): HTMLElement | null {
    return this.registry.getByActionRef(actionRef)?.itemEl ?? null;
  }

  /**
   * Exact tool correlation is translated to the item's actionRef before a
   * compatibility review view receives its stable keyed item host.
   */
  getReviewItemForToolCallId(toolCallId: string): HTMLElement | null {
    return this.registry.getByToolCallId(toolCallId)?.itemEl ?? null;
  }

  getReviewHostForToolCallId(toolCallId: string): HTMLElement | null {
    return this.registry.getByToolCallId(toolCallId)?.actionEl ?? null;
  }

  getProvisionalReviewHost(): HTMLElement {
    this.provisionalSectionEl.removeClass("lmsa-hidden");
    return this.provisionalHostEl;
  }

  refreshActionSectionVisibility(): void {
    this.updateActionSectionVisibility();
  }

  getPrimaryProseHost(): HTMLElement | null {
    const proseStates = this.itemOrder
      .map((id) => this.itemStates.get(id))
      .filter(
        (state): state is ItemViewState =>
          state?.type === "prose",
      );
    return proseStates.length === 1 ? proseStates[0].contentEl : null;
  }

  getProseHost(proseItemId: string): HTMLElement | null {
    const state = this.itemStates.get(proseItemId);
    return state?.type === "prose" ? state.contentEl : null;
  }

  setActionReviewContext(
    getEligibility: (
      entry: ToolActionLedgerEntry,
      targetId: string,
    ) => ActionControlEligibility,
    onControl: (
      entry: ToolActionLedgerEntry,
      targetId: string,
      control: ActionReviewControl,
    ) => void,
  ): void {
    this.getActionEligibility = getEligibility;
    this.onActionControl = onControl;
    this.actionCoordinator.reconcile(this.actionLedger);
    this.updateActionSectionVisibility();
  }

  async flush(): Promise<void> {
    while (this.pendingRenders.size > 0) {
      await Promise.all([...this.pendingRenders]);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.renderSequencer.destroy();
    for (const state of this.itemStates.values()) {
      state.destroy();
      this.markdownRenderer.clear(state.contentEl);
    }
    this.itemStates.clear();
    this.itemOrder = [];
    this.renderItems.clear();
    this.actionCoordinator.destroy();
    this.registry.clear();
    this.rootEl.remove();
  }

  private async refreshModel(
    model: AssistantTurnRenderModel,
    actionLedger: readonly ToolActionLedgerEntry[],
    regexEditPreview: RegexEditPreview | null,
  ): Promise<void> {
    this.rootEl.removeClass(
      "is-streaming",
      "is-completed",
      "is-interrupted",
      "is-failed",
    );
    this.rootEl.addClass(`is-${model.status}`);

    const plan = planAssistantTurnRenderUpdate(
      this.itemOrder.flatMap((itemId) => {
        const item = this.renderItems.get(itemId);
        return item ? [item] : [];
      }),
      model.items,
    );
    for (const itemId of plan.removed) this.removeItem(itemId);
    const changed = new Set([...plan.added, ...plan.updated]);

    const proseRenders: Promise<void>[] = [];
    let cursor = this.listEl.firstElementChild;
    for (const item of model.items) {
      let state = this.itemStates.get(item.id);
      if (state && state.type !== item.type) {
        this.removeItem(item.id);
        state = undefined;
      }
      let created = false;
      if (!state) {
        state = this.createItem(item);
        this.itemStates.set(item.id, state);
        created = true;
      }
      if (state.itemEl !== cursor) {
        this.listEl.insertBefore(state.itemEl, cursor);
      } else {
        cursor = cursor.nextElementSibling;
      }
      if (created || changed.has(item.id)) {
        this.updateItemIdentity(state, item);
        this.updateMarker(state, item);
        if (item.type === "prose") {
          proseRenders.push(this.updateProse(state, item.text));
        } else {
          this.updateTool(state, item);
        }
      }
      cursor = state.itemEl.nextElementSibling;
    }
    this.itemOrder = plan.order;
    this.renderItems = new Map(
      model.items.map((item) => [item.id, item]),
    );
    this.updateEmptyState(model);
    this.updateNotice(model);
    this.updateRegexEditPreview(regexEditPreview);
    this.actionLedger = actionLedger;
    this.actionCoordinator.reconcile(actionLedger);
    this.updateActionSectionVisibility();
    await Promise.all(proseRenders);
    this.onContentChanged();
  }

  private createItem(item: AssistantTurnRenderItem): ItemViewState {
    const itemEl = this.listEl.createEl("li", {
      cls: `lmsa-assistant-turn-item lmsa-assistant-turn-item--${item.type}`,
    });
    const markerEl = itemEl.createDiv({
      cls: "lmsa-assistant-turn-marker",
    });
    markerEl.setAttribute("aria-hidden", "true");
    const contentEl = itemEl.createDiv({
      cls:
        item.type === "prose"
          ? "lmsa-assistant-turn-item-body lmsa-assistant-turn-prose " +
            "lmsa-chat-window-message-content lmsa-chat-window-message-content--markdown"
          : "lmsa-assistant-turn-item-body lmsa-agentic-timeline-step-body",
    });
    const actionEl = contentEl.createDiv({
      cls: "lmsa-assistant-turn-action-host",
    });
    const host: AssistantTurnItemHost = {
      itemEl,
      contentEl,
      actionEl,
    };
    this.registry.register(item.id, host);

    const state: ItemViewState = {
      type: item.type,
      itemEl,
      markerEl,
      contentEl,
      actionEl,
      destroy: () => undefined,
    };
    if (item.type === "tool_call") this.initializeTool(state);
    return state;
  }

  private initializeTool(state: ItemViewState): void {
    const toolSummaryEl = state.contentEl.createSpan({
      cls: "lmsa-assistant-turn-tool-summary",
    });
    const nameEl = toolSummaryEl.createSpan({
      cls: "lmsa-agentic-timeline-step-name",
    });
    const detailEl = toolSummaryEl.createSpan({
      cls: "lmsa-agentic-timeline-step-detail",
    });
    // A question and its answer are the reader's own words, not diagnostics. They
    // get their own full-width slot under the step, alongside where an edit's diff
    // hunk and a write's preview mount, rather than a line squeezed into the
    // summary row or buried in the collapsed disclosure.
    const askEl = state.contentEl.createDiv({
      cls: "lmsa-assistant-turn-ask lmsa-hidden",
    });
    askEl.addEventListener("click", (event) => event.stopPropagation());
    const diagnosticsEl = state.contentEl.createDiv({
      cls: "lmsa-agentic-timeline-step-expand lmsa-hidden",
      attr: { "aria-hidden": "true" },
    });
    toolSummaryEl.after(state.actionEl);
    const toggleDisclosure = () => {
      const tool = state.tool;
      if (!tool?.hasDisclosure) return;
      tool.expanded = !tool.expanded;
      tool.toolSummaryEl.setAttribute(
        "aria-expanded",
        String(tool.expanded),
      );
      tool.diagnosticsEl.toggleClass("lmsa-hidden", !tool.expanded);
      tool.diagnosticsEl.setAttribute(
        "aria-hidden",
        String(!tool.expanded),
      );
    };
    const onToolSummaryClick = () => toggleDisclosure();
    const onToolSummaryKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggleDisclosure();
    };
    toolSummaryEl.addEventListener("click", onToolSummaryClick);
    toolSummaryEl.addEventListener("keydown", onToolSummaryKeydown);
    state.tool = {
      toolSummaryEl,
      nameEl,
      detailEl,
      askEl,
      diagnosticsEl,
      expanded: false,
      hasDisclosure: false,
    };
    state.destroy = () => {
      toolSummaryEl.removeEventListener("click", onToolSummaryClick);
      toolSummaryEl.removeEventListener("keydown", onToolSummaryKeydown);
    };
  }

  private updateItemIdentity(
    state: ItemViewState,
    item: AssistantTurnRenderItem,
  ): void {
    state.itemEl.dataset.itemId = item.id;
    state.itemEl.dataset.segmentId = item.segmentId;
    if (item.type === "tool_call" && item.toolCallId) {
      state.itemEl.dataset.toolCallId = item.toolCallId;
    } else {
      delete state.itemEl.dataset.toolCallId;
    }
    if (item.actionRef) {
      state.itemEl.dataset.actionRef = item.actionRef;
    } else {
      delete state.itemEl.dataset.actionRef;
    }
    this.registry.bindIdentity(item.id, {
      ...(item.actionRef === undefined
        ? {}
        : { actionRef: item.actionRef }),
      ...(item.type !== "tool_call" || item.toolCallId === undefined
        ? {}
        : { toolCallId: item.toolCallId }),
    });
  }

  private updateMarker(
    state: ItemViewState,
    item: AssistantTurnRenderItem,
  ): void {
    state.itemEl.toggleClass(
      "has-connector-before",
      item.connector.before,
    );
    state.itemEl.toggleClass(
      "has-connector-after",
      item.connector.after,
    );
    state.itemEl.toggleClass(
      "has-fading-endpoint",
      item.fadeIncomingConnector,
    );
    state.markerEl.empty();
    state.markerEl.removeClass(
      "is-streaming",
      "is-thinking",
      "is-tool",
      "is-iconless",
    );
    if (item.marker === "streaming") {
      state.markerEl.addClass("is-streaming");
      setIcon(state.markerEl, "ellipsis");
    } else if (item.marker === "thinking") {
      state.markerEl.addClass("is-thinking");
      setIcon(state.markerEl, "brain");
    } else if (item.marker === "tool") {
      state.markerEl.addClass("is-tool");
      if (item.type === "tool_call") {
        setIcon(state.markerEl, toolIcon(item.toolName));
      }
    } else {
      state.markerEl.addClass("is-iconless");
    }
  }

  private updateProse(
    state: ItemViewState,
    text: string,
  ): Promise<void> {
    if (
      state.renderedText === text ||
      state.requestedText === text
    ) {
      return Promise.resolve();
    }
    state.requestedText = text;
    const token = this.renderSequencer.begin(state.itemEl.dataset.itemId ?? "");
    const stagingEl = state.contentEl.createDiv();
    stagingEl.remove();
    stagingEl.addClass(
      "lmsa-chat-window-message-content",
      "lmsa-chat-window-message-content--markdown",
    );
    const render = this.markdownRenderer
      .render(stagingEl, text)
      .then(() => {
        if (
          !this.renderSequencer.isCurrent(token) ||
          !state.itemEl.isConnected
        ) {
          this.markdownRenderer.clear(stagingEl);
          return;
        }
        this.markdownRenderer.clear(state.contentEl);
        this.clearRenderedProse(state.contentEl);
        state.contentEl.prepend(...Array.from(stagingEl.childNodes));
        state.renderedText = text;
        state.requestedText = undefined;
      })
      .catch(() => {
        if (!this.renderSequencer.isCurrent(token)) return;
        this.markdownRenderer.clear(state.contentEl);
        this.clearRenderedProse(state.contentEl);
        state.contentEl.prepend(state.contentEl.ownerDocument.createTextNode(text));
        state.renderedText = text;
        state.requestedText = undefined;
      })
      .finally(() => {
        this.pendingRenders.delete(render);
      });
    this.pendingRenders.add(render);
    return render;
  }

  /**
   * Drop the previously rendered markdown, and only that.
   *
   * The action hosts are the item's, not the markdown's: a prose item can anchor a
   * review (a regex-parsed edit does exactly that), and both its controls and the diff
   * beneath them have to survive re-rendering the words above them.
   */
  private clearRenderedProse(contentEl: HTMLElement): void {
    contentEl
      .querySelectorAll(
        ":scope > :not(.lmsa-assistant-turn-action-host):not(.lmsa-action-evidence)",
      )
      .forEach((element) => element.remove());
  }

  private updateTool(
    state: ItemViewState,
    item: AssistantTurnToolRenderItem,
  ): void {
    const refs = state.tool;
    if (!refs) return;
    state.itemEl.removeClass(...ITEM_STATE_CLASSES);
    state.itemEl.addClass(`is-${item.state}`);
    state.itemEl.toggleClass("is-mutating", isMutatingTool(item.toolName));
    refs.nameEl.setText(item.label);
    refs.detailEl.setText(item.toolInput ?? "");
    refs.detailEl.toggleClass("lmsa-hidden", !item.toolInput);
    refs.toolSummaryEl.setAttribute(
      "aria-label",
      [item.label, item.toolInput, item.accessibleState]
        .filter((part): part is string => Boolean(part))
        .join(", "),
    );
    refs.hasDisclosure = item.hasDisclosure;
    refs.toolSummaryEl.toggleClass("is-expandable", item.hasDisclosure);
    if (item.hasDisclosure) {
      refs.toolSummaryEl.setAttribute("role", "button");
      refs.toolSummaryEl.setAttribute("tabindex", "0");
      refs.toolSummaryEl.setAttribute(
        "aria-expanded",
        String(refs.expanded),
      );
    } else {
      refs.expanded = false;
      refs.toolSummaryEl.removeAttribute("role");
      refs.toolSummaryEl.removeAttribute("tabindex");
      refs.toolSummaryEl.removeAttribute("aria-expanded");
      refs.diagnosticsEl.addClass("lmsa-hidden");
      refs.diagnosticsEl.setAttribute("aria-hidden", "true");
    }
    this.renderAskTranscript(refs.askEl, item);
    this.renderToolDiagnostics(refs.diagnosticsEl, item);
  }

  /**
   * The questions the assistant asked and the answers given, kept in the
   * transcript because reading back a conversation is when they matter most.
   * Steps that asked nothing render an empty, hidden slot.
   */
  private renderAskTranscript(
    askEl: HTMLElement,
    item: AssistantTurnToolRenderItem,
  ): void {
    askEl.empty();
    const questions = item.askGuidance?.questions ?? [];
    askEl.toggleClass("lmsa-hidden", questions.length === 0);
    for (const question of questions) {
      const rowEl = askEl.createDiv({ cls: "lmsa-assistant-turn-ask-row" });
      rowEl.createDiv({
        cls: "lmsa-assistant-turn-ask-question",
        text: question.question,
      });
      const answers = Array.isArray(question.answer)
        ? question.answer
        : [question.answer];
      const answerEl = rowEl.createDiv({
        cls: "lmsa-assistant-turn-ask-answer",
      });
      setIcon(
        answerEl.createSpan({ cls: "lmsa-assistant-turn-ask-answer-icon" }),
        "corner-down-right",
      );
      answerEl.createSpan({ text: answers.join(", ") });
    }
  }

  private renderToolDiagnostics(
    diagnosticsEl: HTMLElement,
    item: AssistantTurnToolRenderItem,
  ): void {
    diagnosticsEl.empty();
    if (item.errorContent) {
      this.renderDiagnosticEntry(
        diagnosticsEl,
        "Error",
        item.errorContent,
        true,
      );
    }
    if (item.toolArgs) {
      for (const [key, value] of Object.entries(item.toolArgs)) {
        this.renderDiagnosticEntry(
          diagnosticsEl,
          key,
          typeof value === "string"
            ? value
            : JSON.stringify(value, null, 2),
        );
      }
    } else if (item.toolArguments.trim()) {
      this.renderDiagnosticEntry(
        diagnosticsEl,
        "Arguments",
        item.toolArguments,
      );
    }
    if (item.resultRecord) {
      this.renderDiagnosticEntry(
        diagnosticsEl,
        "Result",
        item.resultRecord,
      );
    } else if (item.resultDigest) {
      this.renderDiagnosticEntry(
        diagnosticsEl,
        "Result",
        item.resultDigest,
      );
    }
  }

  private renderDiagnosticEntry(
    containerEl: HTMLElement,
    label: string,
    value: string,
    error = false,
  ): void {
    const entryEl = containerEl.createDiv({
      cls:
        "lmsa-agentic-timeline-arg-entry" +
        (error ? " lmsa-assistant-turn-diagnostic-error" : ""),
    });
    entryEl.createSpan({
      cls: "lmsa-agentic-timeline-arg-key",
      text: label,
    });
    entryEl.createEl("pre", {
      cls: "lmsa-agentic-timeline-arg-value",
      text: value,
    });
  }

  private updateEmptyState(model: AssistantTurnRenderModel): void {
    const emptyState = model.emptyState;
    this.emptyEl.toggleClass("lmsa-hidden", !emptyState);
    if (!emptyState) {
      this.emptyEl.removeAttribute("role");
      this.emptyEl.removeAttribute("aria-hidden");
      return;
    }
    this.emptyEl.removeClass(
      "is-streaming",
      "is-completed",
      "is-interrupted",
      "is-failed",
    );
    this.emptyEl.addClass(`is-${emptyState.kind}`);
    this.emptyLabelEl.setText(emptyState.label);
    this.emptyMarkerEl.empty();
    setIcon(
      this.emptyMarkerEl,
      emptyState.kind === "streaming"
        ? "ellipsis"
        : emptyState.kind === "failed"
          ? "circle-alert"
          : "circle-minus",
    );
    if (emptyState.announce) {
      this.emptyEl.setAttribute("role", "status");
      this.emptyEl.removeAttribute("aria-hidden");
    } else {
      this.emptyEl.removeAttribute("role");
      if (emptyState.kind === "streaming") {
        this.emptyEl.setAttribute("aria-hidden", "true");
      } else {
        this.emptyEl.removeAttribute("aria-hidden");
      }
    }
  }

  private updateNotice(model: AssistantTurnRenderModel): void {
    this.noticeEl.toggleClass("lmsa-hidden", !model.notice);
    if (!model.notice) {
      this.noticeEl.removeAttribute("role");
      this.noticeEl.setText("");
      return;
    }
    this.noticeEl.setText(model.notice.label);
    this.noticeEl.setAttribute("role", "status");
    this.noticeEl.toggleClass(
      "is-error",
      model.notice.kind === "failed",
    );
  }

  private updateRegexEditPreview(
    preview: RegexEditPreview | null,
  ): void {
    this.regexPreviewEl.toggleClass("lmsa-hidden", !preview);
    if (!preview) {
      this.regexPreviewEl.removeAttribute("role");
      this.regexPreviewEl.setText("");
      return;
    }
    this.regexPreviewEl.setAttribute("role", "status");
    const count = preview.completeBlockCount;
    const completeLabel =
      count === 1
        ? "1 edit block is ready for review."
        : `${count} edit blocks are ready for review.`;
    if (preview.hasIncompleteBlock) {
      this.regexPreviewEl.setText(
        count === 0
          ? "Receiving an edit block."
          : `Receiving another edit block. ${completeLabel}`,
      );
      return;
    }
    this.regexPreviewEl.setText(completeLabel);
  }

  private removeItem(itemId: string): void {
    const state = this.itemStates.get(itemId);
    if (!state) return;
    this.renderSequencer.invalidate(itemId);
    state.destroy();
    this.markdownRenderer.clear(state.contentEl);
    state.itemEl.remove();
    this.registry.unregister(itemId);
    this.itemStates.delete(itemId);
  }

  private createActionSection(
    className: string,
    heading: string,
    ariaLabel: string,
  ): HTMLElement {
    const sectionEl = this.rootEl.createEl("section", {
      cls: `${className} lmsa-assistant-turn-action-section lmsa-hidden`,
      attr: { "aria-label": ariaLabel },
    });
    sectionEl.createDiv({
      cls: "lmsa-assistant-turn-action-section-heading",
      text: heading,
    });
    return sectionEl;
  }

  private updateActionSectionVisibility(): void {
    this.provisionalSectionEl.toggleClass(
      "lmsa-hidden",
      this.provisionalHostEl.childElementCount === 0,
    );
    this.auditSectionEl.toggleClass(
      "lmsa-hidden",
      this.auditHostEl.childElementCount === 0,
    );
  }

  private assertActive(): void {
    if (this.destroyed) {
      throw new Error("The assistant turn view is destroyed.");
    }
  }
}

/**
 * One action-ledger entry as the transcript keeps it: what the reader can still do
 * about it, and what it changed.
 *
 * Both halves are rendered from the same durable entry, so a mutation reviewed during
 * the turn keeps its diff afterwards, through a reload and a conversation switch. Every
 * family is welcome here, edits included: the live edit review is torn down with the
 * generation that owned it, and nothing else durable would speak for those hunks.
 */
class ActionLedgerEntryView implements AssistantActionView {
  readonly element: HTMLElement;
  readonly presentationEl: HTMLElement;

  private readonly evidenceView: ActionLedgerEvidenceView;

  constructor(
    entry: ToolActionLedgerEntry,
    containerEl: HTMLElement,
    app: App,
    private readonly getEligibility: (
      entry: ToolActionLedgerEntry,
      targetId: string,
    ) => ActionControlEligibility,
    private readonly onControl: (
      entry: ToolActionLedgerEntry,
      targetId: string,
      control: ActionReviewControl,
    ) => void,
  ) {
    this.element = containerEl.createDiv();
    this.element.remove();
    this.element.addClass("lmsa-assistant-turn-action-summary");
    this.evidenceView = new ActionLedgerEvidenceView(app, containerEl);
    this.presentationEl = this.evidenceView.element;
    this.refresh(entry);
  }

  refresh(entry: ToolActionLedgerEntry): void {
    this.evidenceView.refresh(entry);
    this.element.empty();
    this.element.dataset.actionRef = entry.actionRef;
    if (entry.placement.state === "provisional") {
      this.element.createDiv({
        cls: "lmsa-assistant-turn-action-placement",
        text: "Waiting for the provider declaration.",
      });
    } else if (entry.placement.state === "unplaced") {
      this.element.createDiv({
        cls: "lmsa-assistant-turn-action-placement is-warning",
        text:
          "The action has effect history, but no provider declaration could be placed.",
      });
    }
    const model = buildActionLedgerReviewModel(
      entry,
      (targetId) => this.getEligibility(entry, targetId),
    );
    // Only what the reader can still act on. An action with nothing left to decide
    // is already told by its own step, so it contributes no row at all.
    const actionable = model.targets.filter(
      (target) => target.controls.length > 0,
    );
    // The step names the one thing it acted on. Only a multi-target action has to
    // say which target a button belongs to.
    const nameTargets = actionable.length > 1;
    for (const target of actionable) {
      const controlsEl = this.element.createDiv({
        cls: "lmsa-assistant-turn-action-controls",
      });
      if (nameTargets) {
        controlsEl.createSpan({
          cls: "lmsa-assistant-turn-action-target-label",
          text: target.label,
        });
      }
      for (const control of target.controls) {
        const label = actionControlLabel(control);
        const buttonEl = controlsEl.createEl("button", {
          cls: `lmsa-assistant-turn-action-control is-${control}`,
          attr: {
            type: "button",
            "aria-label": `${label} ${target.label}`,
          },
        });
        setIcon(buttonEl, ACTION_CONTROL_ICONS[control]);
        buttonEl.addEventListener("click", () => {
          this.onControl(entry, target.targetId, control);
        });
      }
    }
  }

  destroy(): void {
    this.evidenceView.destroy();
  }
}

export function actionTargetLabels(
  entry: ToolActionLedgerEntry,
): string[] {
  switch (entry.family) {
    case "edit":
      return entry.payload.targets.map(
        (target) =>
          `${target.targetFilePath}, lines ${target.resolvedEdit.startLine}` +
          `–${target.resolvedEdit.endLine}`,
      );
    case "vault_op":
      return entry.payload.targets.map((target) => target.summary);
    case "memory":
      return entry.payload.targets.map((target) =>
        target.mutation.kind === "add"
          ? `Add ${target.mutation.memory.name}`
          : `Forget ${target.mutation.name}`,
      );
    case "interaction":
      return entry.payload.targets.map(
        (target) => `${target.header}: ${target.question}`,
      );
  }
}

/**
 * Glyph per review control. These are quiet icon affordances, not buttons, so the
 * word lives in the `aria-label` and the icon carries the row. Same vocabulary the
 * edit channel already uses for the identical decisions
 * ({@link ./editReviewTimeline.EditReviewTimelineView}), so one action reads the same
 * whichever renderer owns it. `play` is Apply, which runs an approved target whose
 * effect has not happened yet.
 */
const ACTION_CONTROL_ICONS: Record<ActionReviewControl, string> = {
  approve: "check",
  decline: "x",
  apply: "play",
  undo: "undo-2",
};

/** The word behind each glyph, for the button's accessible name. */
function actionControlLabel(control: ActionReviewControl): string {
  switch (control) {
    case "approve":
      return "Approve";
    case "decline":
      return "Decline";
    case "apply":
      return "Apply";
    case "undo":
      return "Undo";
  }
}

const NO_ACTION_ELIGIBILITY: ActionControlEligibility = {
  canApprove: false,
  canDecline: false,
  canApply: false,
  canUndo: false,
};

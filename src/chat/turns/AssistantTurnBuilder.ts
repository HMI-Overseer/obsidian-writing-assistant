import type {
  AssistantProseItem,
  AssistantToolCallItem,
  AssistantToolLifecycleState,
  AssistantTurnRecord,
  AssistantTurnSchemaVersion,
  AssistantTurnSegment,
  AssistantTurnStatus,
  CompletedAskGuidanceRecord,
  ProviderCaptureDiagnostic,
  ProviderQuiescence,
  ProviderReplayCapsule,
} from "../../shared/types";
import { generateId } from "../../utils";
import { validateAssistantTurn } from "./assistantTurnValidation";

export type AssistantTurnBuilderIdKind = "segment" | "item";

export interface AssistantTurnBuilderOptions {
  turnId: string;
  createId?: (kind: AssistantTurnBuilderIdKind) => string;
}

export interface StartAssistantTurnSegment {
  segmentId?: string;
  providerMessageId?: string;
  replayCapsule?: ProviderReplayCapsule;
}

export interface AppendAssistantProseOptions {
  providerBlockId?: string;
  deltaKey?: string;
}

export type AssistantToolCorrelation = "provider_id" | "plugin_id";

export interface StartAssistantToolCall {
  declarationKey: string;
  providerBlockId?: string;
  toolCallId?: string;
  correlation?: AssistantToolCorrelation;
  toolName?: string;
  itemId?: string;
  sourceItemId?: string;
  toolInput?: string;
  actionRef?: string;
  round?: number;
}

export interface AppendAssistantToolArgumentsOptions {
  deltaKey?: string;
}

export interface AssistantToolLifecycleUpdate {
  state?: AssistantToolLifecycleState;
  toolName?: string;
  toolInput?: string;
  resultRecord?: string;
  resultDigest?: string;
  isError?: boolean;
  errorContent?: string;
  actionRef?: string;
  askGuidance?: CompletedAskGuidanceRecord;
  askStatus?: "completed" | "cancelled" | "skipped";
  round?: number;
}

export interface CompletedAssistantProseBlock {
  type: "prose";
  providerBlockId: string;
  text: string;
}

export interface CompletedAssistantToolCallBlock {
  type: "tool_call";
  providerBlockId: string;
  toolCallId: string;
  toolName: string;
  toolArguments: string;
}

export type CompletedAssistantSegmentBlock =
  | CompletedAssistantProseBlock
  | CompletedAssistantToolCallBlock;

export interface CompletedAssistantSegment {
  segmentId: string;
  providerMessageId?: string;
  replayCapsule?: ProviderReplayCapsule;
  blocks: CompletedAssistantSegmentBlock[];
}

export type AssistantTurnSnapshotToolCallItem = Omit<
  AssistantToolCallItem,
  "toolCallId"
> & {
  toolCallId?: string;
};

export type AssistantTurnSnapshotItem =
  | AssistantProseItem
  | AssistantTurnSnapshotToolCallItem;

export interface AssistantTurnSnapshot {
  schemaVersion: AssistantTurnSchemaVersion;
  id: string;
  status: AssistantTurnStatus;
  segments: AssistantTurnSegment[];
  items: AssistantTurnSnapshotItem[];
  quiescence?: ProviderQuiescence;
  captureDiagnostics?: ProviderCaptureDiagnostic[];
}

type TerminalAssistantTurnStatus = Exclude<AssistantTurnStatus, "streaming">;

interface MutableSegment extends AssistantTurnSegment {
  finished: boolean;
  toolCount: number;
}

interface MutableProseItem extends AssistantProseItem {
  providerBlockIds: Set<string>;
}

interface MutableToolCallItem
  extends Omit<AssistantToolCallItem, "toolCallId"> {
  toolCallId?: string;
  declarationKey: string;
  declarationIndex: number;
  providerBlockId?: string;
  correlation?: AssistantToolCorrelation;
}

type MutableItem = MutableProseItem | MutableToolCallItem;

interface PendingLifecycle {
  itemId: string;
  update: AssistantToolLifecycleUpdate;
}

interface RecordedDelta {
  target: string;
  delta: string;
}

interface ReconciledProseRun {
  type: "prose";
  providerBlockIds: string[];
  text: string;
}

type ReconciledPart = ReconciledProseRun | CompletedAssistantToolCallBlock;

export class AssistantTurnBuilderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssistantTurnBuilderError";
  }
}

/**
 * Mutable declaration reducer for one assistant turn.
 *
 * Only structured declaration events position items. Lifecycle callbacks may
 * reserve an identity and buffer state by exact tool-call ID, but they never
 * append an item. Every public snapshot is detached and deeply frozen.
 */
export class AssistantTurnBuilder {
  private readonly turnId: string;
  private readonly createId: (kind: AssistantTurnBuilderIdKind) => string;
  private readonly segments: MutableSegment[] = [];
  private readonly segmentById = new Map<string, MutableSegment>();
  private readonly items: MutableItem[] = [];
  private readonly itemById = new Map<string, MutableItem>();
  private readonly declarationByKey = new Map<string, MutableToolCallItem>();
  private readonly toolByCallId = new Map<string, MutableToolCallItem>();
  private readonly toolItemReservationByCallId = new Map<string, string>();
  private readonly pendingLifecycleByCallId = new Map<string, PendingLifecycle>();
  private readonly providerBlockItemIds = new Map<string, string>();
  private readonly proseDeltaByKey = new Map<string, RecordedDelta>();
  private readonly argumentDeltaByKey = new Map<string, RecordedDelta>();
  private readonly domainIds = new Set<string>();
  private activeSegmentId: string | null = null;
  private openProseItemId: string | null = null;
  private finishedRecord: AssistantTurnRecord | null = null;

  constructor(options: AssistantTurnBuilderOptions) {
    assertNonEmpty(options.turnId, "Turn ID");
    this.turnId = options.turnId;
    this.createId =
      options.createId ?? ((kind) => `${kind}-${generateId()}`);
    this.domainIds.add(options.turnId);
  }

  startSegment(input: StartAssistantTurnSegment = {}): string {
    this.assertMutable();
    const generated = input.segmentId === undefined;
    const segmentId = input.segmentId ?? this.nextDomainId("segment");
    assertNonEmpty(segmentId, "Segment ID");

    const existing = this.segmentById.get(segmentId);
    if (existing) {
      this.mergeSegmentMetadata(existing, input);
      if (!existing.finished && this.activeSegmentId !== segmentId) {
        throw new AssistantTurnBuilderError(
          `Segment "${segmentId}" is open but is not the active segment.`,
        );
      }
      return segmentId;
    }

    if (this.activeSegmentId !== null) {
      throw new AssistantTurnBuilderError(
        `Finish segment "${this.activeSegmentId}" before starting "${segmentId}".`,
      );
    }
    if (!generated) this.claimDomainId(segmentId, "segment");

    const segment: MutableSegment = {
      id: segmentId,
      ...(input.providerMessageId === undefined
        ? {}
        : { providerMessageId: validatedText(input.providerMessageId, "Provider message ID") }),
      ...(input.replayCapsule === undefined
        ? {}
        : { replayCapsule: cloneValue(input.replayCapsule) }),
      finished: false,
      toolCount: 0,
    };
    this.segments.push(segment);
    this.segmentById.set(segmentId, segment);
    this.activeSegmentId = segmentId;
    return segmentId;
  }

  appendProseDelta(
    segmentId: string,
    delta: string,
    options: AppendAssistantProseOptions = {},
  ): string | null {
    this.assertMutable();
    assertNonEmpty(segmentId, "Segment ID");
    if (delta.length === 0) return null;

    const repeatedTarget = this.checkRepeatedDelta(
      this.proseDeltaByKey,
      options.deltaKey,
      delta,
      "prose",
    );
    if (repeatedTarget !== null) return repeatedTarget;

    const segment = this.requireWritableSegment(segmentId);
    const blockKey =
      options.providerBlockId === undefined
        ? null
        : this.providerBlockKey(segmentId, options.providerBlockId);
    const blockItem =
      blockKey === null ? undefined : this.itemForProviderBlock(blockKey);
    let prose = blockItem?.type === "prose" ? blockItem : this.openProseItem();

    if (blockItem && blockItem.type !== "prose") {
      throw new AssistantTurnBuilderError(
        `Provider block "${options.providerBlockId}" is already a tool declaration.`,
      );
    }
    if (prose && prose.segmentId !== segment.id) prose = null;
    if (prose && this.openProseItemId !== prose.id) {
      throw new AssistantTurnBuilderError(
        `Provider block "${options.providerBlockId}" cannot resume after tool activity.`,
      );
    }

    if (!prose) {
      const itemId = this.nextDomainId("item");
      prose = {
        type: "prose",
        id: itemId,
        segmentId,
        text: "",
        providerBlockIds: new Set<string>(),
      };
      this.items.push(prose);
      this.itemById.set(itemId, prose);
      this.openProseItemId = itemId;
    }

    prose.text += delta;
    if (blockKey !== null) {
      prose.providerBlockIds.add(blockKey);
      this.providerBlockItemIds.set(blockKey, prose.id);
    }
    this.recordDelta(
      this.proseDeltaByKey,
      options.deltaKey,
      prose.id,
      delta,
    );
    return prose.id;
  }

  startToolCall(segmentId: string, input: StartAssistantToolCall): string {
    this.assertMutable();
    const segment = this.requireWritableSegment(segmentId);
    assertNonEmpty(input.declarationKey, "Declaration key");

    const existing = this.declarationByKey.get(input.declarationKey);
    if (existing) {
      this.mergeRepeatedToolStart(existing, segmentId, input);
      return existing.id;
    }

    this.openProseItemId = null;
    const itemId = this.resolveDeclaredToolItemId(input);
    const tool: MutableToolCallItem = {
      type: "tool_call",
      id: itemId,
      segmentId,
      ...(input.sourceItemId === undefined
        ? {}
        : { sourceItemId: validatedText(input.sourceItemId, "Source item ID") }),
      toolName: input.toolName ?? "",
      toolArguments: "",
      ...(input.toolInput === undefined ? {} : { toolInput: input.toolInput }),
      state: "declared",
      ...(input.actionRef === undefined
        ? {}
        : { actionRef: validatedText(input.actionRef, "Action reference") }),
      ...(input.round === undefined ? {} : { round: input.round }),
      declarationKey: input.declarationKey,
      declarationIndex: segment.toolCount,
    };
    segment.toolCount += 1;

    this.items.push(tool);
    this.itemById.set(itemId, tool);
    this.declarationByKey.set(input.declarationKey, tool);
    this.bindProviderBlock(tool, input.providerBlockId);

    if (input.toolCallId !== undefined) {
      this.bindToolCallId(
        input.declarationKey,
        input.toolCallId,
        input.correlation ?? "provider_id",
      );
    }
    return itemId;
  }

  appendToolNameDelta(
    declarationKey: string,
    delta: string,
  ): void {
    this.assertMutable();
    const tool = this.requireWritableDeclaration(declarationKey);
    tool.toolName += delta;
  }

  appendToolArgumentsDelta(
    declarationKey: string,
    delta: string,
    options: AppendAssistantToolArgumentsOptions = {},
  ): void {
    this.assertMutable();
    const repeatedTarget = this.checkRepeatedDelta(
      this.argumentDeltaByKey,
      options.deltaKey,
      delta,
      "tool arguments",
    );
    if (repeatedTarget !== null) return;

    const tool = this.requireWritableDeclaration(declarationKey);
    tool.toolArguments += delta;
    this.refreshParsedToolArguments(tool);
    this.recordDelta(
      this.argumentDeltaByKey,
      options.deltaKey,
      declarationKey,
      delta,
    );
  }

  bindToolCallId(
    declarationKey: string,
    toolCallId: string,
    correlation: AssistantToolCorrelation,
  ): string {
    this.assertMutable();
    assertNonEmpty(toolCallId, "Tool-call ID");
    const tool = this.declarationByKey.get(declarationKey);
    if (!tool) {
      throw new AssistantTurnBuilderError(
        `Unknown declaration key "${declarationKey}".`,
      );
    }

    if (tool.toolCallId !== undefined) {
      if (tool.toolCallId !== toolCallId) {
        throw new AssistantTurnBuilderError(
          `Declaration "${declarationKey}" is already bound to "${tool.toolCallId}".`,
        );
      }
      if (tool.correlation !== undefined && tool.correlation !== correlation) {
        throw new AssistantTurnBuilderError(
          `Declaration "${declarationKey}" has conflicting correlation evidence.`,
        );
      }
      tool.correlation = correlation;
      return tool.id;
    }

    const positioned = this.toolByCallId.get(toolCallId);
    if (positioned && positioned !== tool) {
      throw new AssistantTurnBuilderError(
        `Tool-call ID "${toolCallId}" is already bound to item "${positioned.id}".`,
      );
    }
    const reservedId = this.toolItemReservationByCallId.get(toolCallId);
    if (reservedId !== undefined && reservedId !== tool.id) {
      throw new AssistantTurnBuilderError(
        `Tool-call ID "${toolCallId}" reserved item "${reservedId}", not "${tool.id}".`,
      );
    }

    tool.toolCallId = toolCallId;
    tool.correlation = correlation;
    this.toolByCallId.set(toolCallId, tool);
    this.toolItemReservationByCallId.set(toolCallId, tool.id);
    this.applyPendingLifecycle(toolCallId, tool);
    return tool.id;
  }

  reserveToolItemId(toolCallId: string, itemId?: string): string {
    this.assertMutable();
    assertNonEmpty(toolCallId, "Tool-call ID");
    const positioned = this.toolByCallId.get(toolCallId);
    if (positioned) {
      if (itemId !== undefined && itemId !== positioned.id) {
        throw new AssistantTurnBuilderError(
          `Tool-call ID "${toolCallId}" already owns item "${positioned.id}".`,
        );
      }
      return positioned.id;
    }

    const existing = this.toolItemReservationByCallId.get(toolCallId);
    if (existing !== undefined) {
      if (itemId !== undefined && itemId !== existing) {
        throw new AssistantTurnBuilderError(
          `Tool-call ID "${toolCallId}" already reserves item "${existing}".`,
        );
      }
      return existing;
    }

    const reservedId = itemId ?? this.nextDomainId("item");
    if (itemId !== undefined) this.claimDomainId(itemId, "item");
    this.toolItemReservationByCallId.set(toolCallId, reservedId);
    return reservedId;
  }

  updateToolLifecycle(
    toolCallId: string,
    update: AssistantToolLifecycleUpdate,
  ): string {
    this.assertMutable();
    assertNonEmpty(toolCallId, "Tool-call ID");
    const tool = this.toolByCallId.get(toolCallId);
    if (tool) {
      this.mergeLifecycleIntoTool(tool, update);
      return tool.id;
    }

    const itemId = this.reserveToolItemId(toolCallId);
    const pending = this.pendingLifecycleByCallId.get(toolCallId);
    const merged = this.mergeLifecycleUpdates(pending?.update ?? {}, update);
    this.pendingLifecycleByCallId.set(toolCallId, { itemId, update: merged });
    return itemId;
  }

  finishSegment(segmentId: string): void {
    this.assertMutable();
    const segment = this.segmentById.get(segmentId);
    if (!segment) {
      throw new AssistantTurnBuilderError(`Unknown segment "${segmentId}".`);
    }
    if (segment.finished) return;
    if (this.activeSegmentId !== segmentId) {
      throw new AssistantTurnBuilderError(
        `Segment "${segmentId}" is not the active segment.`,
      );
    }

    this.openProseItemId = null;
    for (const item of this.items) {
      if (item.type !== "tool_call" || item.segmentId !== segmentId) continue;
      if (item.toolName.trim().length === 0) {
        throw new AssistantTurnBuilderError(
          `Tool declaration "${item.declarationKey}" has no tool name.`,
        );
      }
      if (item.toolCallId === undefined) {
        const fallback = `lmsa-tool-${segmentId}-${item.declarationIndex}`;
        this.bindToolCallId(item.declarationKey, fallback, "plugin_id");
      }
    }

    segment.finished = true;
    this.activeSegmentId = null;
  }

  reconcileCompletedSegment(completed: CompletedAssistantSegment): void {
    this.assertMutable();
    const segment = this.segmentById.get(completed.segmentId);
    if (!segment) {
      throw new AssistantTurnBuilderError(
        `Unknown segment "${completed.segmentId}".`,
      );
    }
    this.mergeSegmentMetadata(segment, completed);

    const parts = this.groupCompletedBlocks(completed);
    const reconciledItems = parts.map((part) =>
      part.type === "prose"
        ? this.reconcileProseRun(completed.segmentId, part)
        : this.reconcileToolBlock(completed.segmentId, segment, part),
    );
    this.assertNoToolDeclarationWasOmitted(completed.segmentId, reconciledItems);
    this.replaceSegmentItems(completed.segmentId, reconciledItems);
    if (this.activeSegmentId === completed.segmentId) {
      this.openProseItemId = null;
    }
  }

  finishTurn(status: TerminalAssistantTurnStatus): AssistantTurnRecord {
    if (this.finishedRecord) {
      if (this.finishedRecord.status !== status) {
        throw new AssistantTurnBuilderError(
          `Turn already finished as "${this.finishedRecord.status}".`,
        );
      }
      return this.finishedRecord;
    }

    if (this.activeSegmentId !== null) {
      this.finishSegment(this.activeSegmentId);
    }
    if (status === "interrupted") {
      for (const item of this.items) {
        if (
          item.type === "tool_call" &&
          (item.state === "declared" || item.state === "running")
        ) {
          item.state = "interrupted";
        }
      }
    }

    const record = this.buildSnapshot(status);
    for (const item of record.items) {
      if (item.type === "tool_call" && item.toolCallId === undefined) {
        throw new AssistantTurnBuilderError(
          `Tool item "${item.id}" has no final tool-call ID.`,
        );
      }
    }
    const candidate = record as AssistantTurnRecord;
    const validation = validateAssistantTurn(candidate);
    if (!validation.ok) {
      throw new AssistantTurnBuilderError(
        `Finished turn is invalid at ${validation.reason.path}: ` +
          validation.reason.code,
      );
    }
    this.finishedRecord = freezeClone(validation.value);
    return this.finishedRecord;
  }

  snapshot(): AssistantTurnSnapshot {
    if (this.finishedRecord) return this.finishedRecord;
    return freezeClone(this.buildSnapshot("streaming"));
  }

  private assertMutable(): void {
    if (this.finishedRecord) {
      throw new AssistantTurnBuilderError("The assistant turn is already finished.");
    }
  }

  private nextDomainId(kind: AssistantTurnBuilderIdKind): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = this.createId(kind);
      assertNonEmpty(id, `${kind} ID`);
      if (!this.domainIds.has(id)) {
        this.domainIds.add(id);
        return id;
      }
    }
    throw new AssistantTurnBuilderError(
      `The ID factory could not produce a unique ${kind} ID.`,
    );
  }

  private claimDomainId(id: string, kind: AssistantTurnBuilderIdKind): void {
    assertNonEmpty(id, `${kind} ID`);
    if (this.domainIds.has(id)) {
      throw new AssistantTurnBuilderError(
        `Domain ID "${id}" is already in use.`,
      );
    }
    this.domainIds.add(id);
  }

  private mergeSegmentMetadata(
    segment: MutableSegment,
    input: Pick<StartAssistantTurnSegment, "providerMessageId" | "replayCapsule">,
  ): void {
    if (input.providerMessageId !== undefined) {
      assertNonEmpty(input.providerMessageId, "Provider message ID");
      segment.providerMessageId = mergeIdentityField(
        segment.providerMessageId,
        input.providerMessageId,
        `Segment "${segment.id}" provider message ID`,
      );
    }
    if (input.replayCapsule !== undefined) {
      if (
        segment.replayCapsule !== undefined &&
        !valuesEqual(segment.replayCapsule, input.replayCapsule)
      ) {
        throw new AssistantTurnBuilderError(
          `Segment "${segment.id}" has conflicting replay capsules.`,
        );
      }
      segment.replayCapsule = cloneValue(input.replayCapsule);
    }
  }

  private requireWritableSegment(segmentId: string): MutableSegment {
    const segment = this.segmentById.get(segmentId);
    if (!segment) {
      throw new AssistantTurnBuilderError(`Unknown segment "${segmentId}".`);
    }
    if (segment.finished) {
      throw new AssistantTurnBuilderError(`Segment "${segmentId}" is finished.`);
    }
    if (this.activeSegmentId !== segmentId) {
      throw new AssistantTurnBuilderError(
        `Segment "${segmentId}" is not the active segment.`,
      );
    }
    return segment;
  }

  private openProseItem(): MutableProseItem | null {
    if (this.openProseItemId === null) return null;
    const item = this.itemById.get(this.openProseItemId);
    return item?.type === "prose" ? item : null;
  }

  private providerBlockKey(segmentId: string, providerBlockId: string): string {
    assertNonEmpty(providerBlockId, "Provider block ID");
    return `${segmentId}\u0000${providerBlockId}`;
  }

  private itemForProviderBlock(blockKey: string): MutableItem | undefined {
    const itemId = this.providerBlockItemIds.get(blockKey);
    return itemId === undefined ? undefined : this.itemById.get(itemId);
  }

  private bindProviderBlock(
    tool: MutableToolCallItem,
    providerBlockId: string | undefined,
  ): void {
    if (providerBlockId === undefined) return;
    const blockKey = this.providerBlockKey(tool.segmentId, providerBlockId);
    const existing = this.providerBlockItemIds.get(blockKey);
    if (existing !== undefined && existing !== tool.id) {
      throw new AssistantTurnBuilderError(
        `Provider block "${providerBlockId}" already belongs to item "${existing}".`,
      );
    }
    if (
      tool.providerBlockId !== undefined &&
      tool.providerBlockId !== providerBlockId
    ) {
      throw new AssistantTurnBuilderError(
        `Tool item "${tool.id}" already uses provider block "${tool.providerBlockId}".`,
      );
    }
    tool.providerBlockId = providerBlockId;
    this.providerBlockItemIds.set(blockKey, tool.id);
  }

  private resolveDeclaredToolItemId(input: StartAssistantToolCall): string {
    const reserved =
      input.toolCallId === undefined
        ? undefined
        : this.toolItemReservationByCallId.get(input.toolCallId);
    if (
      input.itemId !== undefined &&
      reserved !== undefined &&
      input.itemId !== reserved
    ) {
      throw new AssistantTurnBuilderError(
        `Tool-call ID "${input.toolCallId}" reserves item "${reserved}".`,
      );
    }
    if (reserved !== undefined) return reserved;
    if (input.itemId !== undefined) {
      this.claimDomainId(input.itemId, "item");
      return input.itemId;
    }
    return this.nextDomainId("item");
  }

  private mergeRepeatedToolStart(
    tool: MutableToolCallItem,
    segmentId: string,
    input: StartAssistantToolCall,
  ): void {
    if (tool.segmentId !== segmentId) {
      throw new AssistantTurnBuilderError(
        `Declaration "${input.declarationKey}" already belongs to segment "${tool.segmentId}".`,
      );
    }
    if (input.itemId !== undefined && input.itemId !== tool.id) {
      throw new AssistantTurnBuilderError(
        `Declaration "${input.declarationKey}" already owns item "${tool.id}".`,
      );
    }
    this.bindProviderBlock(tool, input.providerBlockId);
    tool.toolName = mergeIdentityField(
      emptyToUndefined(tool.toolName),
      emptyToUndefined(input.toolName),
      `Declaration "${input.declarationKey}" tool name`,
    ) ?? "";
    tool.sourceItemId = mergeIdentityField(
      tool.sourceItemId,
      input.sourceItemId,
      `Declaration "${input.declarationKey}" source item ID`,
    );
    tool.toolInput = mergeIdentityField(
      tool.toolInput,
      input.toolInput,
      `Declaration "${input.declarationKey}" tool input`,
    );
    tool.actionRef = mergeIdentityField(
      tool.actionRef,
      input.actionRef,
      `Declaration "${input.declarationKey}" action reference`,
    );
    tool.round = mergeScalarField(
      tool.round,
      input.round,
      `Declaration "${input.declarationKey}" round`,
    );
    if (input.toolCallId !== undefined) {
      this.bindToolCallId(
        input.declarationKey,
        input.toolCallId,
        input.correlation ?? "provider_id",
      );
    }
  }

  private requireWritableDeclaration(
    declarationKey: string,
  ): MutableToolCallItem {
    const tool = this.declarationByKey.get(declarationKey);
    if (!tool) {
      throw new AssistantTurnBuilderError(
        `Unknown declaration key "${declarationKey}".`,
      );
    }
    this.requireWritableSegment(tool.segmentId);
    return tool;
  }

  private refreshParsedToolArguments(tool: MutableToolCallItem): void {
    const parsed = parseJsonObject(tool.toolArguments);
    if (parsed === null) {
      delete tool.toolArgs;
    } else {
      tool.toolArgs = parsed;
    }
  }

  private applyPendingLifecycle(
    toolCallId: string,
    tool: MutableToolCallItem,
  ): void {
    const pending = this.pendingLifecycleByCallId.get(toolCallId);
    if (!pending) return;
    if (pending.itemId !== tool.id) {
      throw new AssistantTurnBuilderError(
        `Lifecycle for "${toolCallId}" reserves item "${pending.itemId}", not "${tool.id}".`,
      );
    }
    this.mergeLifecycleIntoTool(tool, pending.update);
    this.pendingLifecycleByCallId.delete(toolCallId);
  }

  private mergeLifecycleIntoTool(
    tool: MutableToolCallItem,
    update: AssistantToolLifecycleUpdate,
  ): void {
    if (update.state !== undefined) {
      tool.state = mergeLifecycleState(tool.state, update.state);
    }
    tool.toolName = mergeIdentityField(
      emptyToUndefined(tool.toolName),
      emptyToUndefined(update.toolName),
      `Tool "${tool.id}" name`,
    ) ?? "";
    tool.toolInput = mergeIdentityField(
      tool.toolInput,
      update.toolInput,
      `Tool "${tool.id}" input`,
    );
    tool.resultRecord = mergeIdentityField(
      tool.resultRecord,
      update.resultRecord,
      `Tool "${tool.id}" result record`,
    );
    tool.resultDigest = mergeIdentityField(
      tool.resultDigest,
      update.resultDigest,
      `Tool "${tool.id}" result digest`,
    );
    tool.isError = mergeScalarField(
      tool.isError,
      update.isError,
      `Tool "${tool.id}" error flag`,
    );
    tool.errorContent = mergeIdentityField(
      tool.errorContent,
      update.errorContent,
      `Tool "${tool.id}" error content`,
    );
    tool.actionRef = mergeIdentityField(
      tool.actionRef,
      update.actionRef,
      `Tool "${tool.id}" action reference`,
    );
    tool.askGuidance = mergeValueField(
      tool.askGuidance,
      update.askGuidance,
      `Tool "${tool.id}" ask guidance`,
    );
    tool.askStatus = mergeScalarField(
      tool.askStatus,
      update.askStatus,
      `Tool "${tool.id}" ask status`,
    );
    tool.round = mergeScalarField(
      tool.round,
      update.round,
      `Tool "${tool.id}" round`,
    );
  }

  private mergeLifecycleUpdates(
    current: AssistantToolLifecycleUpdate,
    update: AssistantToolLifecycleUpdate,
  ): AssistantToolLifecycleUpdate {
    const merged: AssistantToolLifecycleUpdate = cloneValue(current);
    if (update.state !== undefined) {
      merged.state =
        current.state === undefined
          ? update.state
          : mergeLifecycleState(current.state, update.state);
    }
    mergeUpdateField(merged, update, "toolName");
    mergeUpdateField(merged, update, "toolInput");
    mergeUpdateField(merged, update, "resultRecord");
    mergeUpdateField(merged, update, "resultDigest");
    mergeUpdateField(merged, update, "isError");
    mergeUpdateField(merged, update, "errorContent");
    mergeUpdateField(merged, update, "actionRef");
    mergeUpdateField(merged, update, "askGuidance");
    mergeUpdateField(merged, update, "askStatus");
    mergeUpdateField(merged, update, "round");
    return merged;
  }

  private checkRepeatedDelta(
    events: Map<string, RecordedDelta>,
    deltaKey: string | undefined,
    delta: string,
    label: string,
  ): string | null {
    if (deltaKey === undefined) return null;
    assertNonEmpty(deltaKey, "Delta key");
    const previous = events.get(deltaKey);
    if (!previous) return null;
    if (previous.delta !== delta) {
      throw new AssistantTurnBuilderError(
        `${label} delta key "${deltaKey}" was reused with different bytes.`,
      );
    }
    return previous.target;
  }

  private recordDelta(
    events: Map<string, RecordedDelta>,
    deltaKey: string | undefined,
    target: string,
    delta: string,
  ): void {
    if (deltaKey !== undefined) events.set(deltaKey, { target, delta });
  }

  private groupCompletedBlocks(
    completed: CompletedAssistantSegment,
  ): ReconciledPart[] {
    const seenBlockIds = new Set<string>();
    const parts: ReconciledPart[] = [];
    let proseRun: ReconciledProseRun | null = null;

    for (const block of completed.blocks) {
      assertNonEmpty(block.providerBlockId, "Provider block ID");
      if (seenBlockIds.has(block.providerBlockId)) {
        throw new AssistantTurnBuilderError(
          `Completed segment repeats provider block "${block.providerBlockId}".`,
        );
      }
      seenBlockIds.add(block.providerBlockId);

      if (block.type === "prose") {
        if (!proseRun) {
          proseRun = { type: "prose", providerBlockIds: [], text: "" };
          parts.push(proseRun);
        }
        proseRun.providerBlockIds.push(block.providerBlockId);
        proseRun.text += block.text;
        continue;
      }

      assertNonEmpty(block.toolCallId, "Completed tool-call ID");
      assertNonEmpty(block.toolName, "Completed tool name");
      proseRun = null;
      parts.push(block);
    }

    return parts.filter((part) => part.type !== "prose" || part.text.length > 0);
  }

  private reconcileProseRun(
    segmentId: string,
    part: ReconciledProseRun,
  ): MutableProseItem {
    const existingItems = new Set<MutableProseItem>();
    for (const providerBlockId of part.providerBlockIds) {
      const blockKey = this.providerBlockKey(segmentId, providerBlockId);
      const item = this.itemForProviderBlock(blockKey);
      if (item?.type === "tool_call") {
        throw new AssistantTurnBuilderError(
          `Provider block "${providerBlockId}" changed from tool to prose.`,
        );
      }
      if (item) existingItems.add(item);
    }
    if (existingItems.size > 1) {
      throw new AssistantTurnBuilderError(
        "A completed prose run maps to more than one existing prose item.",
      );
    }

    const prose =
      existingItems.values().next().value ??
      this.createReconciledProseItem(segmentId);
    prose.text = part.text;
    for (const providerBlockId of part.providerBlockIds) {
      const blockKey = this.providerBlockKey(segmentId, providerBlockId);
      prose.providerBlockIds.add(blockKey);
      this.providerBlockItemIds.set(blockKey, prose.id);
    }
    return prose;
  }

  private createReconciledProseItem(segmentId: string): MutableProseItem {
    const prose: MutableProseItem = {
      type: "prose",
      id: this.nextDomainId("item"),
      segmentId,
      text: "",
      providerBlockIds: new Set<string>(),
    };
    this.itemById.set(prose.id, prose);
    return prose;
  }

  private reconcileToolBlock(
    segmentId: string,
    segment: MutableSegment,
    block: CompletedAssistantToolCallBlock,
  ): MutableToolCallItem {
    const blockKey = this.providerBlockKey(segmentId, block.providerBlockId);
    const byBlock = this.itemForProviderBlock(blockKey);
    if (byBlock?.type === "prose") {
      throw new AssistantTurnBuilderError(
        `Provider block "${block.providerBlockId}" changed from prose to tool.`,
      );
    }
    const byCall = this.toolByCallId.get(block.toolCallId);
    if (byBlock && byCall && byBlock !== byCall) {
      throw new AssistantTurnBuilderError(
        `Completed tool "${block.toolCallId}" conflicts with provider block identity.`,
      );
    }

    const tool =
      byBlock ??
      byCall ??
      this.createReconciledToolItem(segmentId, segment, block);
    this.bindProviderBlock(tool, block.providerBlockId);
    if (tool.toolCallId === undefined) {
      this.bindToolCallId(tool.declarationKey, block.toolCallId, "provider_id");
    } else if (tool.toolCallId !== block.toolCallId) {
      throw new AssistantTurnBuilderError(
        `Tool item "${tool.id}" is already bound to "${tool.toolCallId}".`,
      );
    }
    tool.toolName = block.toolName;
    tool.toolArguments = block.toolArguments;
    this.refreshParsedToolArguments(tool);
    return tool;
  }

  private createReconciledToolItem(
    segmentId: string,
    segment: MutableSegment,
    block: CompletedAssistantToolCallBlock,
  ): MutableToolCallItem {
    const declarationKey = `completed:${segmentId}:${block.providerBlockId}`;
    if (this.declarationByKey.has(declarationKey)) {
      throw new AssistantTurnBuilderError(
        `Completed declaration key "${declarationKey}" is already in use.`,
      );
    }
    const itemId =
      this.toolItemReservationByCallId.get(block.toolCallId) ??
      this.nextDomainId("item");
    const tool: MutableToolCallItem = {
      type: "tool_call",
      id: itemId,
      segmentId,
      toolName: block.toolName,
      toolArguments: block.toolArguments,
      state: "declared",
      declarationKey,
      declarationIndex: segment.toolCount,
    };
    segment.toolCount += 1;
    this.itemById.set(itemId, tool);
    this.declarationByKey.set(declarationKey, tool);
    this.bindToolCallId(declarationKey, block.toolCallId, "provider_id");
    return tool;
  }

  private assertNoToolDeclarationWasOmitted(
    segmentId: string,
    reconciledItems: MutableItem[],
  ): void {
    const retained = new Set(reconciledItems.map((item) => item.id));
    const omitted = this.items.find(
      (item) =>
        item.segmentId === segmentId &&
        item.type === "tool_call" &&
        !retained.has(item.id),
    );
    if (omitted?.type === "tool_call") {
      throw new AssistantTurnBuilderError(
        `Completed segment omitted declaration "${omitted.declarationKey}".`,
      );
    }
  }

  private replaceSegmentItems(
    segmentId: string,
    reconciledItems: MutableItem[],
  ): void {
    const segmentIndex = this.segments.findIndex((segment) => segment.id === segmentId);
    let insertionIndex = this.items.length;
    for (let index = 0; index < this.items.length; index += 1) {
      const itemSegmentIndex = this.segments.findIndex(
        (segment) => segment.id === this.items[index].segmentId,
      );
      if (itemSegmentIndex >= segmentIndex) {
        insertionIndex = index;
        break;
      }
    }

    const previousItems = this.items.filter((item) => item.segmentId === segmentId);
    for (const item of previousItems) {
      if (
        item.type === "prose" &&
        !reconciledItems.some((reconciled) => reconciled.id === item.id)
      ) {
        this.itemById.delete(item.id);
        for (const blockKey of item.providerBlockIds) {
          if (this.providerBlockItemIds.get(blockKey) === item.id) {
            this.providerBlockItemIds.delete(blockKey);
          }
        }
      }
    }

    const withoutSegment = this.items.filter((item) => item.segmentId !== segmentId);
    const priorCount = this.items
      .slice(0, insertionIndex)
      .filter((item) => item.segmentId !== segmentId).length;
    withoutSegment.splice(priorCount, 0, ...reconciledItems);
    this.items.splice(0, this.items.length, ...withoutSegment);
  }

  private buildSnapshot(status: AssistantTurnStatus): AssistantTurnSnapshot {
    return {
      schemaVersion: 1,
      id: this.turnId,
      status,
      segments: this.segments.map((segment) => ({
        id: segment.id,
        ...(segment.providerMessageId === undefined
          ? {}
          : { providerMessageId: segment.providerMessageId }),
        ...(segment.replayCapsule === undefined
          ? {}
          : { replayCapsule: cloneValue(segment.replayCapsule) }),
      })),
      items: this.items.map((item) => this.snapshotItem(item)),
    };
  }

  private snapshotItem(item: MutableItem): AssistantTurnSnapshotItem {
    if (item.type === "prose") {
      return {
        type: "prose",
        id: item.id,
        segmentId: item.segmentId,
        ...(item.sourceItemId === undefined
          ? {}
          : { sourceItemId: item.sourceItemId }),
        text: item.text,
        ...(item.actionRef === undefined ? {} : { actionRef: item.actionRef }),
        ...(item.actionAnchor === undefined
          ? {}
          : { actionAnchor: item.actionAnchor }),
      };
    }
    return {
      type: "tool_call",
      id: item.id,
      segmentId: item.segmentId,
      ...(item.sourceItemId === undefined
        ? {}
        : { sourceItemId: item.sourceItemId }),
      ...(item.toolCallId === undefined
        ? {}
        : { toolCallId: item.toolCallId }),
      toolName: item.toolName,
      toolArguments: item.toolArguments,
      ...(item.toolArgs === undefined
        ? {}
        : { toolArgs: cloneValue(item.toolArgs) }),
      ...(item.toolInput === undefined ? {} : { toolInput: item.toolInput }),
      state: item.state,
      ...(item.resultRecord === undefined
        ? {}
        : { resultRecord: item.resultRecord }),
      ...(item.resultDigest === undefined
        ? {}
        : { resultDigest: item.resultDigest }),
      ...(item.isError === undefined ? {} : { isError: item.isError }),
      ...(item.errorContent === undefined
        ? {}
        : { errorContent: item.errorContent }),
      ...(item.actionRef === undefined ? {} : { actionRef: item.actionRef }),
      ...(item.askGuidance === undefined
        ? {}
        : { askGuidance: cloneValue(item.askGuidance) }),
      ...(item.askStatus === undefined ? {} : { askStatus: item.askStatus }),
      ...(item.round === undefined ? {} : { round: item.round }),
    };
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new AssistantTurnBuilderError(`${label} must be a non-empty string.`);
  }
}

function validatedText(value: string, label: string): string {
  assertNonEmpty(value, label);
  return value;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

function mergeIdentityField(
  current: string | undefined,
  incoming: string | undefined,
  label: string,
): string | undefined {
  if (incoming === undefined) return current;
  if (current !== undefined && current !== incoming) {
    throw new AssistantTurnBuilderError(`${label} cannot be changed.`);
  }
  return incoming;
}

function mergeScalarField<T>(
  current: T | undefined,
  incoming: T | undefined,
  label: string,
): T | undefined {
  if (incoming === undefined) return current;
  if (current !== undefined && current !== incoming) {
    throw new AssistantTurnBuilderError(`${label} cannot be changed.`);
  }
  return incoming;
}

function mergeValueField<T>(
  current: T | undefined,
  incoming: T | undefined,
  label: string,
): T | undefined {
  if (incoming === undefined) return current;
  if (current !== undefined && !valuesEqual(current, incoming)) {
    throw new AssistantTurnBuilderError(`${label} cannot be changed.`);
  }
  return cloneValue(incoming);
}

function mergeLifecycleState(
  current: AssistantToolLifecycleState,
  incoming: AssistantToolLifecycleState,
): AssistantToolLifecycleState {
  if (current === incoming) return current;
  const allowed: Record<AssistantToolLifecycleState, AssistantToolLifecycleState[]> = {
    declared: ["running", "completed", "interrupted", "failed"],
    running: ["completed", "interrupted", "failed"],
    completed: [],
    interrupted: [],
    failed: [],
  };
  if (!allowed[current].includes(incoming)) {
    throw new AssistantTurnBuilderError(
      `Tool lifecycle cannot move from "${current}" to "${incoming}".`,
    );
  }
  return incoming;
}

function mergeUpdateField<Key extends keyof AssistantToolLifecycleUpdate>(
  target: AssistantToolLifecycleUpdate,
  incoming: AssistantToolLifecycleUpdate,
  key: Key,
): void {
  const next = incoming[key];
  if (next === undefined) return;
  const current = target[key];
  if (current !== undefined && !valuesEqual(current, next)) {
    throw new AssistantTurnBuilderError(
      `Buffered lifecycle field "${key}" cannot be changed.`,
    );
  }
  Object.assign(target, { [key]: cloneValue(next) });
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  ) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => valuesEqual(value, right[index]));
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        valuesEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function freezeClone<T>(value: T): T {
  return deepFreeze(cloneValue(value));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

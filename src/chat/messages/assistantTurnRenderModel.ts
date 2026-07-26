import type {
  AgenticStep,
  AssistantTurnRecord,
  CompletedAskGuidanceRecord,
  ConversationMessage,
  ToolActionLedgerEntry,
} from "../../shared/types";
import type {
  AssistantTurnSnapshot,
  AssistantTurnSnapshotItem,
} from "../turns/AssistantTurnBuilder";
import { getActiveAssistantRevision } from "../conversation/assistantRevisions";
import { TOOL_LABELS, pendingToolLabel } from "../../tools/metadata";
import { GENERATION_STOPPED_LABEL } from "../types";

export type AssistantTurnMarker = "streaming" | "thinking" | "tool" | "none";

export interface AssistantTurnConnector {
  before: boolean;
  after: boolean;
}

interface AssistantTurnRenderItemBase {
  id: string;
  segmentId: string;
  marker: AssistantTurnMarker;
  connector: AssistantTurnConnector;
  fadeIncomingConnector: boolean;
  actionRef?: string;
  sourceItemId?: string;
  legacy: boolean;
}

export interface AssistantTurnProseRenderItem
  extends AssistantTurnRenderItemBase {
  type: "prose";
  text: string;
}

export interface AssistantTurnToolRenderItem
  extends AssistantTurnRenderItemBase {
  type: "tool_call";
  toolCallId?: string;
  toolName: string;
  toolArguments: string;
  toolArgs?: Record<string, unknown>;
  toolInput?: string;
  state: "declared" | "running" | "completed" | "interrupted" | "failed";
  resultRecord?: string;
  resultDigest?: string;
  isError?: boolean;
  errorContent?: string;
  askGuidance?: CompletedAskGuidanceRecord;
  askStatus?: "completed" | "cancelled" | "skipped";
  label: string;
  accessibleState: "Pending" | "Running" | "Completed" | "Interrupted" | "Failed";
  hasDisclosure: boolean;
}

export type AssistantTurnRenderItem =
  | AssistantTurnProseRenderItem
  | AssistantTurnToolRenderItem;

export interface AssistantTurnEmptyState {
  kind: "streaming" | "completed" | "interrupted" | "failed";
  label: string;
  announce: boolean;
}

export interface AssistantTurnNotice {
  kind: "interrupted" | "failed";
  label: string;
}

export interface AssistantTurnRenderModel {
  id: string;
  status: AssistantTurnSnapshot["status"];
  items: AssistantTurnRenderItem[];
  emptyState: AssistantTurnEmptyState | null;
  notice: AssistantTurnNotice | null;
}

export interface LegacyAssistantRenderSource {
  key: string;
  status: Exclude<AssistantTurnSnapshot["status"], "streaming"> | "streaming";
  content: string;
  steps?: AgenticStep[];
  runningToolCallIds?: ReadonlySet<string>;
  errorMessage?: string;
}

export type AssistantMessageRenderSource =
  | {
      kind: "turn";
      messageId: string;
      revisionId: string;
      turn: AssistantTurnRecord;
      actionLedger: ToolActionLedgerEntry[];
      errorMessage?: string;
    }
  | {
      kind: "legacy";
      messageId: string;
      revisionId?: string;
      source: LegacyAssistantRenderSource;
    };

export interface AssistantTurnKeyedUpdatePlan {
  order: string[];
  reused: string[];
  added: string[];
  removed: string[];
}

/** Derive display-only marker, connector, lifecycle, and empty-turn state. */
export function buildAssistantTurnRenderModel(
  turn: AssistantTurnSnapshot,
  options: { errorMessage?: string } = {},
): AssistantTurnRenderModel {
  const items = turn.items.map((item, index) =>
    buildRenderItem(item, turn.items[index + 1], turn.status, index, turn.items.length),
  );
  return {
    id: turn.id,
    status: turn.status,
    items,
    emptyState:
      items.length === 0
        ? emptyStateFor(turn.status, options.errorMessage)
        : null,
    notice:
      items.length > 0
        ? noticeFor(turn.status, options.errorMessage)
        : null,
  };
}

/** Project legacy evidence without inventing provider interleaving or domain identity. */
export function buildLegacyAssistantRenderModel(
  source: LegacyAssistantRenderSource,
): AssistantTurnRenderModel {
  const rawItems: AssistantTurnSnapshotItem[] = [];
  const legacyIds: string[] = [];
  for (const [index, step] of (source.steps ?? []).entries()) {
    const id = `legacy:${source.key}:step:${index}`;
    const segmentId = `legacy:${source.key}:segment:${index}`;
    if (step.type === "reasoning") {
      if (!step.text) continue;
      rawItems.push({
        type: "prose",
        id,
        segmentId,
        text: step.text,
      });
      legacyIds.push(id);
      continue;
    }
    rawItems.push({
      type: "tool_call",
      id,
      segmentId,
      ...(step.toolCallId === undefined
        ? {}
        : { toolCallId: step.toolCallId }),
      toolName: step.toolName ?? "Tool call",
      toolArguments: JSON.stringify(step.toolArgs ?? {}),
      ...(step.toolArgs === undefined
        ? {}
        : { toolArgs: structuredClone(step.toolArgs) }),
      ...(step.toolInput === undefined
        ? {}
        : { toolInput: step.toolInput }),
      state: source.runningToolCallIds?.has(step.toolCallId ?? "")
        ? "running"
        : step.isError
          ? "failed"
          : "completed",
      ...(step.resultRecord === undefined
        ? {}
        : { resultRecord: step.resultRecord }),
      ...(step.resultDigest === undefined
        ? {}
        : { resultDigest: step.resultDigest }),
      ...(step.isError ? { isError: true } : {}),
      ...(step.errorContent === undefined
        ? {}
        : { errorContent: step.errorContent }),
      ...(step.askGuidance === undefined
        ? {}
        : { askGuidance: structuredClone(step.askGuidance) }),
      ...(step.askStatus === undefined
        ? {}
        : { askStatus: step.askStatus }),
      round: step.round,
    });
    legacyIds.push(id);
  }
  if (source.content.length > 0) {
    const id = `legacy:${source.key}:content`;
    rawItems.push({
      type: "prose",
      id,
      segmentId: `legacy:${source.key}:content-segment`,
      text: source.content,
    });
    legacyIds.push(id);
  }

  const model = buildAssistantTurnRenderModel(
    {
      schemaVersion: 1,
      id: `legacy:${source.key}`,
      status: source.status,
      segments: [],
      items: rawItems,
    },
    { errorMessage: source.errorMessage },
  );
  return {
    ...model,
    items: model.items.map((item) => ({
      ...item,
      legacy: legacyIds.includes(item.id),
    })),
  };
}

/** Select one canonical revision source for both render and reload. */
export function selectAssistantMessageRenderSource(
  message: ConversationMessage,
): AssistantMessageRenderSource {
  const revision = getActiveAssistantRevision(message);
  if (revision?.kind === "turn") {
    return {
      kind: "turn",
      messageId: message.id,
      revisionId: revision.revisionId,
      turn: revision.turn,
      actionLedger: actionLedgerForTurn(
        message.actionLedger ?? [],
        revision.revisionId,
        revision.turn,
      ),
      ...(revision.errorMessage === undefined
        ? {}
        : { errorMessage: revision.errorMessage }),
    };
  }
  if (revision?.kind === "legacy") {
    return {
      kind: "legacy",
      messageId: message.id,
      revisionId: revision.revisionId,
      source: {
        key: `${message.id}:${revision.revisionId}`,
        status: revisionStatus(revision),
        content: legacyVisibleContent(
          revision.content,
          revision.isError,
        ),
        steps: revision.legacySteps,
        ...legacyErrorOption(
          revision.content,
          revision.isError,
          revision.errorMessage,
        ),
      },
    };
  }
  return {
    kind: "legacy",
    messageId: message.id,
    source: {
      key: message.id,
      status: message.isError
        ? "failed"
        : message.interrupted
          ? "interrupted"
          : "completed",
      content: legacyVisibleContent(message.content, message.isError),
      steps: message.agenticSteps,
      ...legacyErrorOption(
        message.content,
        message.isError,
      ),
    },
  };
}

/** Plan stable keyed host reuse and reject duplicate domain IDs. */
export function planAssistantTurnKeyedUpdate(
  currentOrder: readonly string[],
  nextOrder: readonly string[],
): AssistantTurnKeyedUpdatePlan {
  const current = uniqueIds(currentOrder, "current");
  const next = uniqueIds(nextOrder, "next");
  const currentSet = new Set(current);
  const nextSet = new Set(next);
  return {
    order: [...next],
    reused: next.filter((id) => currentSet.has(id)),
    added: next.filter((id) => !currentSet.has(id)),
    removed: current.filter((id) => !nextSet.has(id)),
  };
}

function buildRenderItem(
  item: AssistantTurnSnapshotItem,
  next: AssistantTurnSnapshotItem | undefined,
  status: AssistantTurnSnapshot["status"],
  index: number,
  itemCount: number,
): AssistantTurnRenderItem {
  const connector = {
    before: true,
    after: index < itemCount - 1,
  };
  if (item.type === "prose") {
    const marker: AssistantTurnMarker =
      status === "streaming" && index === itemCount - 1
        ? "streaming"
        : next?.type === "tool_call"
          ? "thinking"
          : "none";
    const fadeIncomingConnector =
      status === "completed" &&
      index === itemCount - 1 &&
      marker === "none";
    return {
      type: "prose",
      id: item.id,
      segmentId: item.segmentId,
      text: item.text,
      marker,
      connector,
      fadeIncomingConnector,
      ...(item.actionRef === undefined
        ? {}
        : { actionRef: item.actionRef }),
      ...(item.sourceItemId === undefined
        ? {}
        : { sourceItemId: item.sourceItemId }),
      legacy: false,
    };
  }
  return {
    type: "tool_call",
    id: item.id,
    segmentId: item.segmentId,
    ...(item.toolCallId === undefined
      ? {}
      : { toolCallId: item.toolCallId }),
    toolName: item.toolName,
    toolArguments: item.toolArguments,
    ...(item.toolArgs === undefined
      ? {}
      : { toolArgs: structuredClone(item.toolArgs) }),
    ...(item.toolInput === undefined
      ? {}
      : { toolInput: item.toolInput }),
    state: item.state,
    ...(item.resultRecord === undefined
      ? {}
      : { resultRecord: item.resultRecord }),
    ...(item.resultDigest === undefined
      ? {}
      : { resultDigest: item.resultDigest }),
    ...(item.isError === undefined
      ? {}
      : { isError: item.isError }),
    ...(item.errorContent === undefined
      ? {}
      : { errorContent: item.errorContent }),
    ...(item.actionRef === undefined
      ? {}
      : { actionRef: item.actionRef }),
    ...(item.sourceItemId === undefined
      ? {}
      : { sourceItemId: item.sourceItemId }),
    ...(item.askGuidance === undefined
      ? {}
      : { askGuidance: structuredClone(item.askGuidance) }),
    ...(item.askStatus === undefined
      ? {}
      : { askStatus: item.askStatus }),
    label: toolLabel(item),
    accessibleState: accessibleToolState(item.state),
    hasDisclosure: hasToolDisclosure(item),
    marker: "tool",
    connector,
    fadeIncomingConnector: false,
    legacy: false,
  };
}

function toolLabel(
  item: Extract<AssistantTurnSnapshotItem, { type: "tool_call" }>,
): string {
  if (item.toolName === "ask_user") {
    if (item.askStatus === "cancelled") {
      return "Question cancelled when generation stopped";
    }
    if (item.askStatus === "skipped") return "Question skipped";
  }
  if (item.state === "declared" || item.state === "running") {
    return pendingToolLabel(item.toolName);
  }
  return TOOL_LABELS[item.toolName] ?? item.toolName;
}

function accessibleToolState(
  state: Extract<AssistantTurnSnapshotItem, { type: "tool_call" }>["state"],
): AssistantTurnToolRenderItem["accessibleState"] {
  switch (state) {
    case "declared":
      return "Pending";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "interrupted":
      return "Interrupted";
    case "failed":
      return "Failed";
  }
}

function hasToolDisclosure(
  item: Extract<AssistantTurnSnapshotItem, { type: "tool_call" }>,
): boolean {
  return (
    item.toolArguments.trim().length > 0 ||
    item.resultRecord !== undefined ||
    item.resultDigest !== undefined ||
    item.errorContent !== undefined ||
    item.askGuidance !== undefined
  );
}

function emptyStateFor(
  status: AssistantTurnSnapshot["status"],
  errorMessage: string | undefined,
): AssistantTurnEmptyState {
  switch (status) {
    case "streaming":
      return {
        kind: "streaming",
        label: "Assistant is responding.",
        announce: false,
      };
    case "completed":
      return {
        kind: "completed",
        label: "No response.",
        announce: false,
      };
    case "interrupted":
      return {
        kind: "interrupted",
        label: GENERATION_STOPPED_LABEL,
        announce: true,
      };
    case "failed":
      return {
        kind: "failed",
        label: errorMessage ? `Error: ${errorMessage}` : "Generation failed.",
        announce: true,
      };
  }
}

function noticeFor(
  status: AssistantTurnSnapshot["status"],
  errorMessage: string | undefined,
): AssistantTurnNotice | null {
  if (status === "interrupted") {
    return {
      kind: "interrupted",
      label: GENERATION_STOPPED_LABEL,
    };
  }
  if (status === "failed") {
    return {
      kind: "failed",
      label: errorMessage ? `Error: ${errorMessage}` : "Generation failed.",
    };
  }
  return null;
}

function revisionStatus(revision: {
  isError?: boolean;
  interrupted?: boolean;
}): Exclude<AssistantTurnSnapshot["status"], "streaming"> {
  if (revision.isError) return "failed";
  if (revision.interrupted) return "interrupted";
  return "completed";
}

function legacyVisibleContent(
  content: string,
  isError: boolean | undefined,
): string {
  return isError && /^Error:\s*/u.test(content) ? "" : content;
}

function legacyErrorOption(
  content: string,
  isError: boolean | undefined,
  errorMessage?: string,
): { errorMessage?: string } {
  if (errorMessage) return { errorMessage };
  if (!isError || !/^Error:\s*/u.test(content)) return {};
  return { errorMessage: content.replace(/^Error:\s*/u, "") };
}

function uniqueIds(ids: readonly string[], label: string): string[] {
  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    throw new Error(`The ${label} assistant turn order contains duplicate item IDs.`);
  }
  return [...ids];
}

function actionLedgerForTurn(
  entries: readonly ToolActionLedgerEntry[],
  revisionId: string,
  turn: AssistantTurnRecord,
): ToolActionLedgerEntry[] {
  const referencedActions = new Set(
    turn.items.flatMap((item) =>
      item.actionRef === undefined ? [] : [item.actionRef],
    ),
  );
  return entries.filter(
    (entry) =>
      entry.revisionId === revisionId ||
      referencedActions.has(entry.actionRef),
  );
}

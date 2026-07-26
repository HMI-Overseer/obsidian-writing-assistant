import type {
  AssistantMessageRevision,
  AssistantRevisionBase,
  AssistantTurnRevision,
  EditActionPayload,
  InteractionActionPayload,
  LegacyAssistantRevision,
  MemoryActionPayload,
  ToolActionCorrelationEvidence,
  ToolActionEffectRecord,
  ToolActionEvent,
  ToolActionFamily,
  ToolActionLedgerEntry,
  ToolActionPlacement,
  ToolActionUndoRecord,
  VaultOpActionPayload,
} from "../../src/shared/types";

const revisionBase = {
  revisionId: "revision-1",
  createdAt: 1,
  provider: "anthropic",
  modelId: "claude-fixture",
  usage: { inputTokens: 1, outputTokens: 2 },
  ragSources: [{ filePath: "Fixture.md", headingPath: "", score: 1 }],
  rewrittenQuery: "fixture query",
  isError: false,
  interrupted: false,
  errorMessage: "fixture error",
} satisfies AssistantRevisionBase;

const turnRevision = {
  ...revisionBase,
  kind: "turn",
  origin: "generated",
  turn: {
    schemaVersion: 1,
    id: "turn-1",
    status: "completed",
    segments: [],
    items: [],
  },
} satisfies AssistantTurnRevision;

const legacyRevision = {
  revisionId: "revision-legacy",
  kind: "legacy",
  content: "Legacy content.",
} satisfies LegacyAssistantRevision;

const correlation = {
  kind: "provider_id",
  toolCallId: "tool-1",
} satisfies ToolActionCorrelationEvidence;

const placements = [
  { state: "provisional", correlation },
  {
    state: "placed",
    anchor: "tool_call",
    itemId: "item-1",
    correlation,
  },
  { state: "placed", anchor: "parsed_edit", itemId: "item-2" },
  {
    state: "unplaced",
    correlation: {
      kind: "none",
      transport: "legacy-stream-json",
      reason: "Exact tool identity was unavailable.",
    },
    reason: "correlation_unavailable",
  },
] satisfies ToolActionPlacement[];

const editPayload = {
  proposalId: "proposal-edit",
  targets: [],
} satisfies EditActionPayload;

const vaultOpPayload = {
  proposalId: "proposal-vault",
  createdAt: 1,
  targets: [],
} satisfies VaultOpActionPayload;

const memoryPayload = {
  targets: [
    {
      targetId: "memory-target",
      mutation: {
        kind: "add",
        memory: {
          name: "fixture-memory",
          type: "rule",
          description: "Fixture memory.",
          enabled: true,
        },
      },
    },
  ],
} satisfies MemoryActionPayload;

const interactionPayload = {
  kind: "ask_user",
  targets: [
    {
      targetId: "question-1",
      question: "Continue?",
      header: "Choice",
      options: ["Yes", "No"],
      multiSelect: false,
    },
  ],
} satisfies InteractionActionPayload;

const effects = [
  {
    family: "edit",
    targetFilePath: "Fixture.md",
    preApplySnapshot: "before",
    postApplySnapshot: "after",
    appliedAt: 2,
  },
  {
    family: "vault_op",
    operation: { kind: "createDir", path: "Fixture" },
    inverse: null,
    appliedAt: 2,
  },
  {
    family: "memory",
    before: null,
    after: {
      name: "fixture-memory",
      type: "rule",
      description: "Fixture memory.",
      enabled: true,
    },
    appliedAt: 2,
  },
  {
    family: "interaction",
    guidance: {
      questions: [{ question: "Continue?", header: "Choice", answer: "Yes" }],
    },
    completedAt: 2,
  },
] satisfies ToolActionEffectRecord[];

const undoRecords = [
  {
    family: "edit",
    targetFilePath: "Fixture.md",
    restoredSnapshot: "before",
    undoneAt: 3,
  },
  {
    family: "vault_op",
    inverse: null,
    undoneAt: 3,
  },
  {
    family: "memory",
    restored: null,
    undoneAt: 3,
  },
] satisfies ToolActionUndoRecord[];

const events = [
  { eventId: "event-1", type: "proposed", targetId: "target-1", createdAt: 1 },
  { eventId: "event-2", type: "approved", targetId: "target-1", createdAt: 2 },
  {
    eventId: "event-3",
    type: "declined",
    targetId: "target-1",
    createdAt: 3,
    reason: "Fixture decline.",
  },
  {
    eventId: "event-4",
    type: "apply_succeeded",
    targetId: "target-1",
    createdAt: 4,
    effect: effects[0],
  },
  {
    eventId: "event-5",
    type: "apply_failed",
    targetId: "target-1",
    createdAt: 5,
    error: "Fixture failure.",
  },
  {
    eventId: "event-6",
    type: "undo_succeeded",
    targetId: "target-1",
    createdAt: 6,
    undo: undoRecords[0],
  },
  {
    eventId: "event-7",
    type: "undo_refused",
    targetId: "target-1",
    createdAt: 7,
    reason: "Fixture refusal.",
  },
  { eventId: "event-8", type: "retry_requested", targetId: "target-1", createdAt: 8 },
  {
    eventId: "event-9",
    type: "superseded",
    targetId: "target-1",
    createdAt: 9,
    replacementRevisionId: "revision-2",
  },
] satisfies ToolActionEvent[];

const ledgerEntries = [
  {
    actionRef: "action-edit",
    revisionId: turnRevision.revisionId,
    family: "edit",
    placement: placements[0],
    payload: editPayload,
    events,
  },
  {
    actionRef: "action-vault",
    revisionId: turnRevision.revisionId,
    family: "vault_op",
    placement: placements[1],
    payload: vaultOpPayload,
    events: [],
  },
  {
    actionRef: "action-memory",
    revisionId: turnRevision.revisionId,
    family: "memory",
    placement: placements[2],
    payload: memoryPayload,
    events: [],
  },
  {
    actionRef: "action-interaction",
    revisionId: turnRevision.revisionId,
    family: "interaction",
    placement: placements[3],
    payload: interactionPayload,
    events: [],
  },
] satisfies ToolActionLedgerEntry[];

const revisions = [
  turnRevision,
  legacyRevision,
] satisfies AssistantMessageRevision[];

const family: ToolActionFamily = ledgerEntries[0].family;

void revisions;
void family;

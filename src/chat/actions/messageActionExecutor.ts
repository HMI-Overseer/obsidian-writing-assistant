import type WritingAssistantChat from "../../main";
import type {
  Memory,
  ToolActionEffectRecord,
  ToolActionEvent,
  ToolActionLedgerEntry,
} from "../../shared/types";
import { generateId } from "../../utils";
import { applyHunksLive, undoHunkLive } from "../../editing/documentApplicator";
import type { DiffHunk } from "../../editing/editTypes";
import { normalizeMemoryName } from "../../memory/validation";
import { applyApprovedMemoryMutation } from "../../tools/memory/handlers";
import {
  applyVaultOpBatch,
  undoVaultOpBatch,
} from "../../vault-ops/applyBatch";
import type { ChatSessionStore } from "../conversation/ChatSessionStore";
import { deriveActionLedgerState } from "../conversation/actionLedger";

export interface ExecuteMessageActionInput {
  plugin: WritingAssistantChat;
  store: ChatSessionStore;
  messageId: string;
  actionRef: string;
  targetId: string;
  control: "apply" | "undo";
}

export async function executeMessageAction(
  input: ExecuteMessageActionInput,
): Promise<boolean> {
  const entry = findEntry(input);
  if (!entry) return false;
  return input.control === "apply"
    ? applyTarget(input, entry)
    : undoTarget(input, entry);
}

async function applyTarget(
  input: ExecuteMessageActionInput,
  entry: ToolActionLedgerEntry,
): Promise<boolean> {
  switch (entry.family) {
    case "edit":
      return applyEdit(input, entry);
    case "vault_op":
      return applyVaultOperation(input, entry);
    case "memory":
      return applyMemory(input, entry);
    case "interaction":
      return false;
  }
}

async function applyEdit(
  input: ExecuteMessageActionInput,
  entry: Extract<ToolActionLedgerEntry, { family: "edit" }>,
): Promise<boolean> {
  const target = entry.payload.targets.find(
    (candidate) => candidate.targetId === input.targetId,
  );
  if (!target) return false;
  const hunk: DiffHunk = {
    id: target.targetId,
    resolvedEdit: structuredClone(target.resolvedEdit),
    status: "pending",
  };
  try {
    const result = await applyHunksLive(
      input.plugin.app,
      target.targetFilePath,
      [hunk],
    );
    if (!result.appliedHunkIds.includes(target.targetId)) {
      return appendApplyFailure(
        input,
        entry,
        "The edit no longer matches the current document.",
      );
    }
    return appendApplySuccess(input, entry, {
      family: "edit",
      targetFilePath: target.targetFilePath,
      preApplySnapshot: result.preContent,
      postApplySnapshot: result.postContent,
      appliedAt: Date.now(),
    });
  } catch (error) {
    return appendApplyFailure(input, entry, messageOf(error));
  }
}

async function applyVaultOperation(
  input: ExecuteMessageActionInput,
  entry: Extract<ToolActionLedgerEntry, { family: "vault_op" }>,
): Promise<boolean> {
  const target = entry.payload.targets.find(
    (candidate) => candidate.targetId === input.targetId,
  );
  if (!target) return false;
  const result = await applyVaultOpBatch(input.plugin.app, [
    { id: target.targetId, op: target.operation },
  ]);
  if (!result.ok) {
    const error =
      result.error ||
      result.conflicts.map((conflict) => conflict.reason).join(" ") ||
      "The vault operation could not be applied.";
    return appendApplyFailure(input, entry, error);
  }
  return appendApplySuccess(input, entry, {
    family: "vault_op",
    operation: structuredClone(target.operation),
    inverse:
      structuredClone(
        result.applied.find(
          (applied) => applied.opId === target.targetId,
        )?.inverse,
      ) ?? null,
    appliedAt: Date.now(),
  });
}

async function applyMemory(
  input: ExecuteMessageActionInput,
  entry: Extract<ToolActionLedgerEntry, { family: "memory" }>,
): Promise<boolean> {
  const target = entry.payload.targets.find(
    (candidate) => candidate.targetId === input.targetId,
  );
  if (!target) return false;
  const memories = input.plugin.settings.memories;
  const name =
    target.mutation.kind === "add"
      ? target.mutation.memory.name
      : target.mutation.name;
  const before = findMemory(memories, name);
  const result = await applyApprovedMemoryMutation(
    {
      id: target.targetId,
      name:
        target.mutation.kind === "add"
          ? "add_memory"
          : "forget_memory",
      arguments:
        target.mutation.kind === "add"
          ? {
              name: target.mutation.memory.name,
              type: target.mutation.memory.type,
              description: target.mutation.memory.description,
              ...(target.mutation.memory.content === undefined
                ? {}
                : { content: target.mutation.memory.content }),
            }
          : { name: target.mutation.name },
    },
    {
      memoryService: input.plugin.services.memoryService,
      getMemories: () => input.plugin.settings.memories,
      saveSettings: () => input.plugin.saveSettings(),
    },
    "applied",
  );
  if (result.isError) {
    return appendApplyFailure(input, entry, result.content);
  }
  return appendApplySuccess(input, entry, {
    family: "memory",
    before,
    after: findMemory(input.plugin.settings.memories, name),
    appliedAt: Date.now(),
  });
}

async function undoTarget(
  input: ExecuteMessageActionInput,
  entry: ToolActionLedgerEntry,
): Promise<boolean> {
  const state = deriveActionLedgerState(entry).targets[input.targetId];
  const effect = state?.latestEffect;
  if (!effect) return false;
  switch (entry.family) {
    case "edit":
      return undoEdit(input, entry, effect);
    case "vault_op":
      return undoVaultOperation(input, entry, effect);
    case "memory":
      return undoMemory(input, entry, effect);
    case "interaction":
      return false;
  }
}

async function undoEdit(
  input: ExecuteMessageActionInput,
  entry: Extract<ToolActionLedgerEntry, { family: "edit" }>,
  effect: ToolActionEffectRecord,
): Promise<boolean> {
  if (effect.family !== "edit") return false;
  const target = entry.payload.targets.find(
    (candidate) => candidate.targetId === input.targetId,
  );
  if (!target) return false;
  const result = await undoHunkLive(
    input.plugin.app,
    target.targetFilePath,
    {
      id: target.targetId,
      resolvedEdit: structuredClone(target.resolvedEdit),
      status: "accepted",
    },
  );
  if (!result.undone || result.restoredContent === null) {
    return appendUndoRefusal(
      input,
      entry,
      "The document changed after the edit, so Undo was refused.",
    );
  }
  return appendUndoSuccess(input, entry, {
    family: "edit",
    targetFilePath: target.targetFilePath,
    restoredSnapshot: result.restoredContent,
    undoneAt: Date.now(),
  });
}

async function undoVaultOperation(
  input: ExecuteMessageActionInput,
  entry: Extract<ToolActionLedgerEntry, { family: "vault_op" }>,
  effect: ToolActionEffectRecord,
): Promise<boolean> {
  if (effect.family !== "vault_op" || effect.inverse === null) {
    return false;
  }
  const result = await undoVaultOpBatch(input.plugin.app, {
    proposalId: entry.payload.proposalId,
    applied: [
      {
        opId: input.targetId,
        inverse: structuredClone(effect.inverse),
      },
    ],
    appliedAt: effect.appliedAt,
  });
  if (!result.ok) {
    return appendUndoRefusal(
      input,
      entry,
      result.failures.join(" ") || "Undo could not be completed.",
    );
  }
  return appendUndoSuccess(input, entry, {
    family: "vault_op",
    inverse: structuredClone(effect.inverse),
    undoneAt: Date.now(),
  });
}

async function undoMemory(
  input: ExecuteMessageActionInput,
  entry: Extract<ToolActionLedgerEntry, { family: "memory" }>,
  effect: ToolActionEffectRecord,
): Promise<boolean> {
  if (effect.family !== "memory") return false;
  const memories = input.plugin.settings.memories;
  const snapshot = structuredClone(memories);
  const refusal = restoreMemoryEffect(memories, effect);
  if (refusal) return appendUndoRefusal(input, entry, refusal);
  try {
    await input.plugin.saveSettings();
    input.plugin.services.memoryService.invalidateAll();
  } catch {
    memories.splice(0, memories.length, ...snapshot);
    return appendUndoRefusal(
      input,
      entry,
      "The memory store could not be saved, so Undo was rolled back.",
    );
  }
  return appendUndoSuccess(input, entry, {
    family: "memory",
    restored:
      effect.before === null ? null : structuredClone(effect.before),
    undoneAt: Date.now(),
  });
}

function restoreMemoryEffect(
  memories: Memory[],
  effect: Extract<ToolActionEffectRecord, { family: "memory" }>,
): string | null {
  if (effect.before === null && effect.after) {
    const index = findMemoryIndex(memories, effect.after.name);
    if (
      index === -1 ||
      JSON.stringify(memories[index]) !== JSON.stringify(effect.after)
    ) {
      return "The memory changed after apply, so Undo was refused.";
    }
    memories.splice(index, 1);
    return null;
  }
  if (effect.before && effect.after === null) {
    if (findMemoryIndex(memories, effect.before.name) !== -1) {
      return "The forgotten memory name is in use again, so Undo was refused.";
    }
    memories.push(structuredClone(effect.before));
    return null;
  }
  return "This memory effect does not have a safe inverse.";
}

function appendApplySuccess(
  input: ExecuteMessageActionInput,
  entry: ToolActionLedgerEntry,
  effect: ToolActionEffectRecord,
): boolean {
  return appendEvent(input, {
    eventId: `event-${generateId()}`,
    type: "apply_succeeded",
    targetId: input.targetId,
    createdAt: eventTime(entry),
    effect,
  });
}

function appendApplyFailure(
  input: ExecuteMessageActionInput,
  entry: ToolActionLedgerEntry,
  error: string,
): boolean {
  return appendEvent(input, {
    eventId: `event-${generateId()}`,
    type: "apply_failed",
    targetId: input.targetId,
    createdAt: eventTime(entry),
    error,
  });
}

function appendUndoSuccess(
  input: ExecuteMessageActionInput,
  entry: ToolActionLedgerEntry,
  undo: Extract<ToolActionEvent, { type: "undo_succeeded" }>["undo"],
): boolean {
  return appendEvent(input, {
    eventId: `event-${generateId()}`,
    type: "undo_succeeded",
    targetId: input.targetId,
    createdAt: eventTime(entry),
    undo,
  });
}

function appendUndoRefusal(
  input: ExecuteMessageActionInput,
  entry: ToolActionLedgerEntry,
  reason: string,
): boolean {
  return appendEvent(input, {
    eventId: `event-${generateId()}`,
    type: "undo_refused",
    targetId: input.targetId,
    createdAt: eventTime(entry),
    reason,
  });
}

function appendEvent(
  input: ExecuteMessageActionInput,
  event: ToolActionEvent,
): boolean {
  return input.store.appendEligibleActionEvent(
    input.messageId,
    input.actionRef,
    event,
  );
}

function eventTime(entry: ToolActionLedgerEntry): number {
  return Math.max(
    Date.now(),
    (entry.events.at(-1)?.createdAt ?? -1) + 1,
  );
}

function findEntry(
  input: ExecuteMessageActionInput,
): ToolActionLedgerEntry | null {
  const message = input.store
    .getSnapshot()
    .messageHistory.find((candidate) => candidate.id === input.messageId);
  return (
    message?.actionLedger?.find(
      (entry) => entry.actionRef === input.actionRef,
    ) ?? null
  );
}

function findMemory(
  memories: readonly Memory[],
  name: string,
): Memory | null {
  const memory = memories.find(
    (candidate) =>
      normalizeMemoryName(candidate.name) === normalizeMemoryName(name),
  );
  return memory ? structuredClone(memory) : null;
}

function findMemoryIndex(memories: readonly Memory[], name: string): number {
  return memories.findIndex(
    (candidate) =>
      normalizeMemoryName(candidate.name) === normalizeMemoryName(name),
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

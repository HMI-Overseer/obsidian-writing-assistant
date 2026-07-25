import type { Memory } from "../../shared/types";
import { estimateStringTokens } from "../../shared/tokenEstimation";
import type { MemoryService } from "../../memory/MemoryService";
import {
  isValidMemoryName,
  normalizeMemoryName,
  validateMemoryCandidate,
  type MemoryValidationIssue,
} from "../../memory/validation";
import type { ToolCall, ToolResult } from "../types";
import { toolFailure } from "../toolFailure";
import { MEMORY_TOOL_NAMES } from "./definition";
import { memoryDispositionMessage } from "./disposition";

export const MEMORY_RECALL_MAX_NAMES = 16;
export const MEMORY_RECALL_MAX_ESTIMATED_TOKENS = 6000;

export interface MemoryToolContext {
  memoryService: MemoryService;
  getMemories: () => Memory[];
  saveSettings: () => Promise<void>;
}

export type MemoryMutation =
  | {
      kind: "add";
      memory: Memory;
      rationale?: string;
    }
  | {
      kind: "forget";
      name: string;
      reason?: string;
    };

export type PreparedMemoryMutation =
  | { ok: true; mutation: MemoryMutation }
  | { ok: false; result: ToolResult };

type RecallItem =
  | {
      name: string;
      status: "hit";
      memory: Omit<Memory, "enabled">;
    }
  | {
      name: string;
      status: "not_found" | "disabled" | "oversized";
      message: string;
    };

/** Execute recall immediately, or validate a mutation as a reviewable proposal. */
export function executeMemoryTool(
  call: ToolCall,
  context: MemoryToolContext,
): ToolResult {
  if (!MEMORY_TOOL_NAMES.has(call.name)) {
    return toolFailure({
      kind: "invalid-args",
      what: `unknown memory tool "${call.name}"`,
      recovery: "call one of the advertised memory tools instead",
    });
  }
  if (call.name === "recall_memory") {
    return recallMemory(call, context.memoryService);
  }

  const prepared = prepareMemoryMutation(call, context.getMemories());
  if (!prepared.ok) return prepared.result;
  const name =
    prepared.mutation.kind === "add"
      ? prepared.mutation.memory.name
      : prepared.mutation.name;
  return {
    content: `${call.name} for memory "${name}" queued for review.`,
    isReadOnly: false,
  };
}

/** Validate and normalize a proposed add or forget against the current store. */
export function prepareMemoryMutation(
  call: ToolCall,
  memories: readonly Memory[],
): PreparedMemoryMutation {
  if (call.name === "add_memory") {
    const validation = validateMemoryCandidate(
      {
        name: call.arguments.name,
        type: call.arguments.type,
        description: call.arguments.description,
        content: call.arguments.content,
      },
      memories.map((memory) => memory.name),
    );
    if (!validation.ok) {
      return { ok: false, result: validationFailure(validation.issue) };
    }
    const rationale = optionalText(call.arguments.rationale, "rationale", false);
    if (!rationale.ok) return rationale;
    return {
      ok: true,
      mutation: {
        kind: "add",
        memory: { ...validation.value, enabled: true },
        ...(rationale.value === undefined ? {} : { rationale: rationale.value }),
      },
    };
  }

  if (call.name === "forget_memory") {
    const rawName = call.arguments.name;
    if (typeof rawName !== "string" || !isValidMemoryName(rawName)) {
      const normalized = typeof rawName === "string" ? normalizeMemoryName(rawName) : "";
      return {
        ok: false,
        result: toolFailure({
          kind: "invalid-args",
          what:
            `name_invalid for forget_memory, the received ${typeof rawName} value is not canonical`,
          recovery: normalized
            ? `retry with the canonical name "${normalized}"`
            : "retry with a non-empty lowercase kebab-case name",
          isReadOnly: false,
        }),
      };
    }
    const existing = memories.find(
      (memory) => normalizeMemoryName(memory.name) === rawName,
    );
    if (!existing) {
      return {
        ok: false,
        result: toolFailure({
          kind: "not-found",
          what: `not_found, memory "${rawName}" does not exist`,
          recovery:
            "check the standing-memory index or call recall_memory with the intended name before retrying",
          isReadOnly: false,
        }),
      };
    }
    const reason = optionalText(call.arguments.reason, "reason", false);
    if (!reason.ok) return reason;
    return {
      ok: true,
      mutation: {
        kind: "forget",
        name: existing.name,
        ...(reason.value === undefined ? {} : { reason: reason.value }),
      },
    };
  }

  return {
    ok: false,
    result: toolFailure({
      kind: "invalid-args",
      what: `unknown memory mutation tool "${call.name}"`,
      recovery: "call add_memory or forget_memory instead",
      isReadOnly: false,
    }),
  };
}

/**
 * Revalidate and apply an approved mutation. Persistence is the commit boundary:
 * a rejected save restores the settings-owned array exactly and invalidates no pin.
 */
export async function applyApprovedMemoryMutation(
  call: ToolCall,
  context: MemoryToolContext,
  disposition: "applied" | "auto-applied",
): Promise<ToolResult> {
  const memories = context.getMemories();
  const prepared = prepareMemoryMutation(call, memories);
  if (!prepared.ok) return prepared.result;

  const mutation = prepared.mutation;
  const snapshot = memories.map((memory) => ({ ...memory }));
  if (mutation.kind === "add") {
    memories.push({ ...mutation.memory });
  } else {
    const index = memories.findIndex(
      (memory) => normalizeMemoryName(memory.name) === normalizeMemoryName(mutation.name),
    );
    if (index >= 0) memories.splice(index, 1);
  }

  try {
    await context.saveSettings();
  } catch {
    memories.splice(0, memories.length, ...snapshot);
    return {
      ...toolFailure({
        kind: "failed",
        what: `${call.name} persistence failed, the memory store was rolled back`,
        recovery: "tell the user the change did not stick, then retry only after storage is available",
        isReadOnly: false,
      }),
      disposition: "failed",
    };
  }

  if (mutation.kind === "forget") {
    context.memoryService.invalidatePinsContaining(mutation.name);
  }
  return {
    content: memoryDispositionMessage(mutation, disposition),
    isReadOnly: false,
    disposition,
  };
}

function recallMemory(call: ToolCall, memoryService: MemoryService): ToolResult {
  const names = call.arguments.names;
  if (!Array.isArray(names) || names.length === 0) {
    return recallArgsFailure(
      `names must be a non-empty array with at most ${MEMORY_RECALL_MAX_NAMES} entries`,
    );
  }
  if (names.length > MEMORY_RECALL_MAX_NAMES) {
    return recallArgsFailure(
      `names has ${names.length} entries, the batch limit is ${MEMORY_RECALL_MAX_NAMES}`,
    );
  }
  if (
    names.some(
      (name) =>
        typeof name !== "string" ||
        !isValidMemoryName(name),
    )
  ) {
    return recallArgsFailure(
      "every names entry must be a canonical lowercase kebab-case memory name up to 64 characters",
    );
  }

  const requestedNames = names as string[];
  const records = memoryService.readRecords(requestedNames);
  const byName = new Map(
    records.map((memory) => [normalizeMemoryName(memory.name), memory]),
  );
  const results: RecallItem[] = [];
  let usedTokens = 0;

  for (const name of requestedNames) {
    const record = byName.get(normalizeMemoryName(name));
    if (!record) {
      results.push({
        name,
        status: "not_found",
        message:
          `not_found, memory "${name}" does not exist; check the memory name in the standing-memory index before retrying`,
      });
      continue;
    }
    if (!record.enabled) {
      results.push({
        name,
        status: "disabled",
        message:
          `disabled, memory "${record.name}" is turned off; ask the user to enable it before retrying`,
      });
      continue;
    }

    const memory = fullRecallRecord(record);
    const hit: RecallItem = { name, status: "hit", memory };
    const estimatedTokens = estimateStringTokens(JSON.stringify(hit));
    if (usedTokens + estimatedTokens > MEMORY_RECALL_MAX_ESTIMATED_TOKENS) {
      results.push({
        name,
        status: "oversized",
        message:
          `oversized, memory "${record.name}" did not fit the aggregate recall budget; retry it in a smaller batch`,
      });
      continue;
    }
    results.push(hit);
    usedTokens += estimatedTokens;
  }

  return {
    content: JSON.stringify({ results }),
    isReadOnly: true,
  };
}

function fullRecallRecord(memory: Memory): Omit<Memory, "enabled"> {
  return memory.content === undefined
    ? {
        name: memory.name,
        type: memory.type,
        description: memory.description,
      }
    : {
        name: memory.name,
        type: memory.type,
        description: memory.description,
        content: memory.content,
      };
}

function recallArgsFailure(what: string): ToolResult {
  return toolFailure({
    kind: "invalid-args",
    what: `invalid recall_memory names, ${what}`,
    recovery:
      `retry with one to ${MEMORY_RECALL_MAX_NAMES} canonical names from the standing-memory index`,
  });
}

function validationFailure(issue: MemoryValidationIssue): ToolResult {
  switch (issue.code) {
    case "name_invalid":
      return toolFailure({
        kind: "invalid-args",
        what: "name_invalid, the memory name is not canonical lowercase kebab-case",
        recovery: issue.normalized
          ? `retry with the canonical name "${issue.normalized}"`
          : "retry with a non-empty lowercase kebab-case name up to 64 characters",
        isReadOnly: false,
      });
    case "name_exists":
      return toolFailure({
        kind: "precondition",
        what: `name_exists, memory "${issue.colliding}" already exists`,
        recovery: "retry with a different name, add_memory never overwrites",
        isReadOnly: false,
      });
    case "type_invalid":
      return toolFailure({
        kind: "invalid-args",
        what: "type_invalid, memory type must be rule or context",
        recovery: "retry with type set to rule or context",
        isReadOnly: false,
      });
    case "description_empty":
      return toolFailure({
        kind: "invalid-args",
        what: "description_empty, description must contain instruction or routing text",
        recovery: "retry with one non-empty description line",
        isReadOnly: false,
      });
    case "description_multiline":
      return toolFailure({
        kind: "invalid-args",
        what: "description_multiline, description contains a line break or control character",
        recovery: "retry with the description on a single line",
        isReadOnly: false,
      });
    case "description_too_long":
      return toolFailure({
        kind: "invalid-args",
        what:
          `description_too_long, description has ${issue.actual} Unicode code points and the limit is ${issue.limit}`,
        recovery: `shorten description to ${issue.limit} Unicode code points or fewer and retry`,
        isReadOnly: false,
      });
    case "content_invalid":
      return toolFailure({
        kind: "invalid-args",
        what: "content_invalid, content must be a string when provided",
        recovery: "retry with string content or omit content",
        isReadOnly: false,
      });
    case "content_too_long":
      return toolFailure({
        kind: "invalid-args",
        what:
          `content_too_long, content has ${issue.actual} Unicode code points and the limit is ${issue.limit}`,
        recovery: `shorten content to ${issue.limit} Unicode code points or fewer and retry`,
        isReadOnly: false,
      });
  }
}

function optionalText(
  value: unknown,
  field: string,
  isReadOnly: boolean,
): { ok: true; value?: string } | { ok: false; result: ToolResult } {
  if (value === undefined) return { ok: true };
  if (typeof value === "string") return { ok: true, value };
  return {
    ok: false,
    result: toolFailure({
      kind: "invalid-args",
      what: `${field} must be a string when provided`,
      recovery: `retry with string ${field} or omit it`,
      isReadOnly,
    }),
  };
}

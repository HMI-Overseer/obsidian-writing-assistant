/**
 * The user-owned half of the memory lifecycle: the Memories tab's five mutations,
 * the master feature switch, and the "Auto-apply memory changes" gate, each
 * expressed as pure data plus one persistence primitive.
 *
 * Two contracts hold everywhere in this file:
 *
 * 1. **Persist first, invalidate second** (plan decision 16). A pin is dropped
 *    only after `saveSettings()` resolves; a rejected save restores the
 *    pre-change value and invalidates nothing, so a failed write can never leave
 *    a live session governed by an index that was never stored.
 * 2. **Targeted versus global invalidation** (plan decision 18). A retraction
 *    (edit, disable, delete) drops only pins whose bytes carried that name, so a
 *    session pinned before the memory existed keeps its pin. The explicit
 *    whole-feature events (add, enable, master toggle) drop every pin, because
 *    the user has just said those records should govern now.
 *
 * Pure: no Obsidian, no DOM. The tab and the composer popover supply the
 * accessors.
 */

import type { Memory } from "../shared/types";
import type { Gate } from "../vault-ops/gateway";
import type { MemoryCandidate, MemoryValidationIssue, MemoryValidationResult } from "./validation";
import {
  MEMORY_NAME_MAX_LENGTH,
  normalizeMemoryName,
  validateMemoryCandidate,
} from "./validation";

/* ── Modal validation ─────────────────────────────────────────────────────── */

/**
 * Validate a Memories-tab submission with the Phase 1 validators. Identity is the
 * normalized name, so a rename must not collide with another stored record; the
 * record being edited is excluded from the collision set, which is what lets a
 * user re-save an entry with its own name unchanged.
 */
export function validateMemoryForm(
  candidate: MemoryCandidate,
  memories: readonly Memory[],
  editingName: string | null,
): MemoryValidationResult {
  const editing = editingName === null ? null : normalizeMemoryName(editingName);
  const existingNames = memories
    .map((record) => record.name)
    .filter((name) => editing === null || normalizeMemoryName(name) !== editing);
  return validateMemoryCandidate(candidate, existingNames);
}

/** One sentence per named issue: what failed, and the correction to make. */
export function memoryValidationMessage(issue: MemoryValidationIssue): string {
  switch (issue.code) {
    case "name_invalid": {
      const rule = `Use lowercase letters, numbers, and hyphens, up to ${MEMORY_NAME_MAX_LENGTH} characters.`;
      return issue.normalized ? `${rule} Try "${issue.normalized}".` : rule;
    }
    case "name_exists":
      return `A memory named "${issue.colliding}" already exists. Pick a different name.`;
    case "type_invalid":
      return "Pick a memory type, either rule or context.";
    case "description_empty":
      return "Enter a description. It is the line the model sees in every request.";
    case "description_multiline":
      return "Keep the description to a single line, with no line breaks.";
    case "description_too_long":
      return `The description is ${issue.actual} characters. Trim it to ${issue.limit} or fewer.`;
    case "content_invalid":
      return "The content must be text.";
    case "content_too_long":
      return `The content is ${issue.actual} characters. Trim it to ${issue.limit} or fewer.`;
  }
}

/* ── Mutations as data ────────────────────────────────────────────────────── */

/** The five mutations the Memories tab can perform, keyed by normalized name. */
export type MemoryMutation =
  | { kind: "add"; memory: Memory }
  | { kind: "edit"; previousName: string; memory: Memory }
  | { kind: "delete"; name: string }
  | { kind: "enable"; name: string }
  | { kind: "disable"; name: string };

export type MemoryInvalidation = { scope: "all" } | { scope: "containing"; name: string };

/** Which pins a mutation retires once it has been persisted (decision 18). */
export function memoryInvalidationFor(mutation: MemoryMutation): MemoryInvalidation {
  switch (mutation.kind) {
    case "add":
    case "enable":
      return { scope: "all" };
    case "edit":
      // The pre-edit name is the one an active pin can carry: a rename's new name
      // is by definition absent from every existing index.
      return { scope: "containing", name: mutation.previousName };
    case "delete":
    case "disable":
      return { scope: "containing", name: mutation.name };
  }
}

/**
 * The post-mutation list. Never mutates its input, and an edit is an in-place
 * replacement so the row keeps its position. A mutation naming a record that is
 * no longer stored returns the list unchanged rather than resurrecting it.
 */
export function applyMemoryMutation(
  memories: readonly Memory[],
  mutation: MemoryMutation,
): Memory[] {
  switch (mutation.kind) {
    case "add":
      return [...memories, { ...mutation.memory }];
    case "edit": {
      const target = normalizeMemoryName(mutation.previousName);
      const index = memories.findIndex((record) => normalizeMemoryName(record.name) === target);
      if (index === -1) return memories.map((record) => ({ ...record }));
      const next = memories.map((record) => ({ ...record }));
      next[index] = { ...mutation.memory };
      return next;
    }
    case "delete": {
      const target = normalizeMemoryName(mutation.name);
      return memories
        .filter((record) => normalizeMemoryName(record.name) !== target)
        .map((record) => ({ ...record }));
    }
    case "enable":
    case "disable": {
      const target = normalizeMemoryName(mutation.name);
      const enabled = mutation.kind === "enable";
      return memories.map((record) =>
        normalizeMemoryName(record.name) === target ? { ...record, enabled } : { ...record },
      );
    }
  }
}

/* ── Persistence ──────────────────────────────────────────────────────────── */

export interface SettingsChange {
  /** Write the new value into settings. */
  apply: () => void;
  /** Restore the pre-change value; runs only when the save rejects. */
  rollback: () => void;
  save: () => Promise<void>;
  /** Runs only after the save resolves (pin invalidation lives here). */
  afterCommit?: () => void;
}

/**
 * Apply, persist, then run the post-persistence effect. A rejected save restores
 * the pre-change value, skips the effect, and rethrows so the caller can surface
 * the failure.
 */
export async function commitSettingsChange(change: SettingsChange): Promise<void> {
  change.apply();
  try {
    await change.save();
  } catch (error) {
    change.rollback();
    throw error;
  }
  change.afterCommit?.();
}

export interface MemoryStoreAccess {
  getMemories: () => Memory[];
  setMemories: (next: Memory[]) => void;
  save: () => Promise<void>;
  invalidateAll: () => void;
  invalidatePinsContaining: (name: string) => void;
}

/** Run one tab mutation end to end: apply, persist, then invalidate per decision 18. */
export async function commitMemoryMutation(
  store: MemoryStoreAccess,
  mutation: MemoryMutation,
): Promise<void> {
  const previous = store.getMemories();
  await commitSettingsChange({
    apply: () => store.setMemories(applyMemoryMutation(previous, mutation)),
    rollback: () => store.setMemories(previous),
    save: store.save,
    afterCommit: () => {
      const invalidation = memoryInvalidationFor(mutation);
      if (invalidation.scope === "all") {
        store.invalidateAll();
      } else {
        store.invalidatePinsContaining(invalidation.name);
      }
    },
  });
}

export interface MemoryFeatureAccess {
  getEnabled: () => boolean;
  setEnabled: (value: boolean) => void;
  save: () => Promise<void>;
  invalidateAll: () => void;
}

/**
 * The master feature switch. Both directions clear every pin: turning the feature
 * on means the latest store should govern immediately, and turning it off means
 * no index may survive in a cached prompt. RFC-0007 accepts the resulting cache
 * re-warm and Claude Code rebuild as the price of an explicit user action.
 */
export async function commitMemoryFeatureToggle(
  access: MemoryFeatureAccess,
  enabled: boolean,
): Promise<void> {
  const previous = access.getEnabled();
  await commitSettingsChange({
    apply: () => access.setEnabled(enabled),
    rollback: () => access.setEnabled(previous),
    save: access.save,
    afterCommit: access.invalidateAll,
  });
}

export interface MemoryGateAccess {
  getGate: () => Gate;
  setGate: (gate: Gate) => void;
  save: () => Promise<void>;
}

/**
 * "Auto-apply memory changes", the one surfacing of `policy.memory`. It writes
 * only `"auto"` or `"ask"`: `"deny"` exists for the gate resolver but is not a
 * toggle position. No pin is touched, because the gate changes who approves a
 * mutation, not what the index says (and a policy change must stay
 * fingerprint-neutral for Claude Code, per plan decision 6).
 */
export async function commitMemoryAutoApply(
  access: MemoryGateAccess,
  autoApply: boolean,
): Promise<void> {
  const previous = access.getGate();
  await commitSettingsChange({
    apply: () => access.setGate(autoApply ? "auto" : "ask"),
    rollback: () => access.setGate(previous),
    save: access.save,
  });
}

/** Whether the tab's auto-apply toggle reads as on for a stored gate. */
export function isMemoryAutoApply(gate: Gate): boolean {
  return gate === "auto";
}

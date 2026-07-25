/**
 * Structural validation for {@link Memory} records (RFC-0007). Structural safety
 * is enforced here; quality (how explicit a description is, how the weight splits
 * between description and content) is advisory and lives in tool guidance, never
 * in a validator. Pure: no Obsidian, no disk.
 *
 * Every rejection is a distinct named issue carrying what failed and the datum
 * needed to fix it, so the tool layer can render one clear correction.
 */

import type { Memory, MemoryType } from "../shared/types";

export const MEMORY_NAME_MAX_LENGTH = 64;
export const MEMORY_DESCRIPTION_MAX_CODE_POINTS = 200;
export const MEMORY_CONTENT_MAX_CODE_POINTS = 4000;

/** Normalized lowercase ASCII kebab-case: the only shape a stored name may have. */
const MEMORY_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const MEMORY_TYPES: readonly MemoryType[] = ["rule", "context"];

/**
 * Collapse arbitrary text toward the canonical name shape: lowercase, whitespace
 * and underscores to hyphens, everything outside `[a-z0-9-]` stripped, hyphen
 * runs collapsed, edge hyphens trimmed. Returns `""` when nothing survives. Used
 * for case-insensitive comparison and for the `name_invalid` suggestion; it does
 * not truncate, so an over-long name stays over-long (and stays invalid).
 */
export function normalizeMemoryName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Whether a name is already in canonical stored form. */
export function isValidMemoryName(name: string): boolean {
  return name.length <= MEMORY_NAME_MAX_LENGTH && MEMORY_NAME_PATTERN.test(name);
}

/**
 * Whether text satisfies the single-line rule: no CR / LF, no Unicode line or
 * paragraph separators (U+2028 / U+2029), and no other control characters
 * (C0 including tab, DEL, C1). Written over code points with hex bounds rather
 * than a character-class regex so the banned set is explicit and grep-able.
 */
export function isSingleLine(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const isControl = cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f);
    const isLineSeparator = cp === 0x2028 || cp === 0x2029;
    if (isControl || isLineSeparator) return false;
  }
  return true;
}

/** Unicode code points, not UTF-16 units: an astral emoji counts once. */
export function codePointLength(text: string): number {
  return [...text].length;
}

export function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === "string" && (MEMORY_TYPES as readonly string[]).includes(value);
}

/**
 * The candidate fields as they arrive from an untrusted producer (tool arguments
 * after `parseToolArguments`, hand-edited JSON, modal input): nothing is assumed
 * to be a string yet.
 */
export interface MemoryCandidate {
  name: unknown;
  type: unknown;
  description: unknown;
  content?: unknown;
}

/**
 * The RFC's named rejection codes plus the three codes total validation of
 * unknown input needs (`type_invalid`, `description_empty`, `content_invalid`
 * cover non-string / out-of-enum fields the RFC's prose enforces without
 * naming). Each carries the datum the correction sentence needs.
 */
export type MemoryValidationIssue =
  | { code: "name_invalid"; normalized: string }
  | { code: "name_exists"; colliding: string }
  | { code: "type_invalid" }
  | { code: "description_empty" }
  | { code: "description_multiline" }
  | { code: "description_too_long"; limit: number; actual: number }
  | { code: "content_invalid" }
  | { code: "content_too_long"; limit: number; actual: number };

export type MemoryValidationResult =
  | { ok: true; value: Omit<Memory, "enabled"> }
  | { ok: false; issue: MemoryValidationIssue };

/**
 * Validate one candidate against the structural rules and the existing name set.
 * Strict on the name: a candidate whose name is not already canonical is
 * rejected with the normalized form to resubmit, never silently rewritten (the
 * caller echoes back exactly what was stored). Collision comparison is
 * case-insensitive via normalization. First failing rule wins: one issue, one
 * correction.
 */
export function validateMemoryCandidate(
  candidate: MemoryCandidate,
  existingNames: readonly string[],
): MemoryValidationResult {
  const { name, type, description, content } = candidate;

  if (typeof name !== "string" || !isValidMemoryName(name)) {
    const normalized = typeof name === "string" ? normalizeMemoryName(name) : "";
    return { ok: false, issue: { code: "name_invalid", normalized } };
  }
  const colliding = existingNames.find((existing) => normalizeMemoryName(existing) === name);
  if (colliding !== undefined) {
    return { ok: false, issue: { code: "name_exists", colliding } };
  }

  if (!isMemoryType(type)) {
    return { ok: false, issue: { code: "type_invalid" } };
  }

  if (typeof description !== "string" || description.trim().length === 0) {
    return { ok: false, issue: { code: "description_empty" } };
  }
  if (!isSingleLine(description)) {
    return { ok: false, issue: { code: "description_multiline" } };
  }
  const descriptionLength = codePointLength(description);
  if (descriptionLength > MEMORY_DESCRIPTION_MAX_CODE_POINTS) {
    return {
      ok: false,
      issue: {
        code: "description_too_long",
        limit: MEMORY_DESCRIPTION_MAX_CODE_POINTS,
        actual: descriptionLength,
      },
    };
  }

  if (content !== undefined) {
    if (typeof content !== "string") {
      return { ok: false, issue: { code: "content_invalid" } };
    }
    const contentLength = codePointLength(content);
    if (contentLength > MEMORY_CONTENT_MAX_CODE_POINTS) {
      return {
        ok: false,
        issue: {
          code: "content_too_long",
          limit: MEMORY_CONTENT_MAX_CODE_POINTS,
          actual: contentLength,
        },
      };
    }
  }

  return {
    ok: true,
    value:
      content === undefined
        ? { name, type, description }
        : { name, type, description, content },
  };
}

import type { JsonRecord } from "./types";

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function readNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return readString(value);
}

export function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const items = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return items.length > 0 ? items : undefined;
}

/**
 * Parse a tool call's JSON `arguments` string into the args object.
 *
 * Returns `{}` for empty input or when the model emitted malformed JSON (or a
 * non-object), rather than throwing or dropping the call. Surfacing the call with
 * empty args lets the tool loop run its normal schema validation and return a
 * self-correcting "invalid arguments" result, which the agentic timeline shows on
 * the step's expandable row (see {@link ../chat/messages/AssistantTurnView}'s
 * `decorateError`). A dropped call would instead vanish silently from the turn,
 * with the only trace left in the developer console, a channel neither the user
 * nor the model can act on.
 */
export function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

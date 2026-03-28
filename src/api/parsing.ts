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

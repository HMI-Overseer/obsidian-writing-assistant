import type {
  AssistantTurnRecord,
  AssistantTurnStatus,
  ProviderReplayCapsule,
} from "../../shared/types";
import {
  RESULT_TRUNCATION_MARKER,
  TOOL_RESULT_CHAR_LIMIT,
} from "../../tools/resultDigest";

export const ASSISTANT_TURN_MAX_SEGMENTS = 256;
export const ASSISTANT_TURN_MAX_ITEMS = 1024;
export const ASSISTANT_TURN_MAX_ID_CHARS = 512;
export const ASSISTANT_TURN_MAX_PROSE_CHARS = 1_000_000;
export const ASSISTANT_TURN_MAX_TOOL_NAME_CHARS = 256;
export const ASSISTANT_TURN_MAX_TOOL_ARGUMENTS_CHARS = 65_536;
export const ASSISTANT_TURN_MAX_TOOL_INPUT_CHARS = 8_000;
export const ASSISTANT_TURN_MAX_RESULT_RECORD_CHARS =
  TOOL_RESULT_CHAR_LIMIT + RESULT_TRUNCATION_MARKER.length;
export const ASSISTANT_TURN_MAX_RESULT_DIGEST_CHARS = 2_000;
export const ASSISTANT_TURN_MAX_ERROR_CONTENT_CHARS = 8_000;
export const ASSISTANT_TURN_MAX_REPLAY_CAPSULE_CHARS = 128 * 1024;

const MAX_PROVIDER_MESSAGE_ID_CHARS = 512;
const MAX_REPLAY_CAPSULE_BLOCKS = 64;
const MAX_JSON_DEPTH = 32;
const MAX_ASK_QUESTIONS = 16;
const MAX_ASK_ANSWER_OPTIONS = 64;
const MAX_ASK_TEXT_CHARS = 8_000;

const TURN_STATUSES: readonly AssistantTurnStatus[] = [
  "streaming",
  "completed",
  "interrupted",
  "failed",
];
const TOOL_STATES = [
  "declared",
  "running",
  "completed",
  "interrupted",
  "failed",
] as const;
const ASK_STATUSES = ["completed", "cancelled", "skipped"] as const;

export type AssistantTurnInvalidReasonCode =
  | "record_invalid"
  | "field_unexpected"
  | "schema_version_unsupported"
  | "status_invalid"
  | "id_invalid"
  | "id_duplicate"
  | "segments_invalid"
  | "segments_too_many"
  | "provider_message_id_invalid"
  | "replay_capsule_invalid"
  | "items_invalid"
  | "items_too_many"
  | "item_type_invalid"
  | "segment_membership_invalid"
  | "segment_order_invalid"
  | "source_item_id_invalid"
  | "prose_empty"
  | "prose_too_long"
  | "prose_action_invalid"
  | "action_ref_invalid"
  | "tool_call_id_invalid"
  | "tool_call_id_duplicate"
  | "tool_name_invalid"
  | "tool_arguments_invalid"
  | "tool_arguments_too_long"
  | "tool_args_invalid"
  | "tool_args_mismatch"
  | "tool_state_invalid"
  | "tool_input_invalid"
  | "result_record_invalid"
  | "result_record_too_long"
  | "result_digest_invalid"
  | "result_digest_too_long"
  | "is_error_invalid"
  | "error_content_invalid"
  | "error_content_too_long"
  | "ask_status_invalid"
  | "ask_guidance_invalid"
  | "round_invalid";

export interface AssistantTurnInvalidReason {
  code: AssistantTurnInvalidReasonCode;
  path: string;
  detail?: string;
}

export type AssistantTurnValidationResult =
  | { ok: true; value: AssistantTurnRecord }
  | { ok: false; reason: AssistantTurnInvalidReason };

export type ProviderReplayCapsuleInvalidReasonCode =
  | "capsule_invalid"
  | "capsule_field_unexpected"
  | "capsule_provider_invalid"
  | "capsule_version_unsupported"
  | "capsule_blocks_invalid"
  | "capsule_too_large"
  | "capsule_block_invalid";

export interface ProviderReplayCapsuleInvalidReason {
  code: ProviderReplayCapsuleInvalidReasonCode;
  path: string;
  detail?: string;
}

export type ProviderReplayCapsuleValidationResult =
  | { ok: true; value: ProviderReplayCapsule }
  | { ok: false; reason: ProviderReplayCapsuleInvalidReason };

interface ValidationContext {
  domainIds: Set<string>;
  segmentIndices: Map<string, number>;
  toolCallIds: Set<string>;
}

/**
 * Strictly validate one persisted schema-1 assistant turn.
 *
 * The validator returns the original value only after the whole chain passes.
 * It never repairs IDs, drops malformed items, or strips a bad replay capsule.
 */
export function validateAssistantTurn(
  value: unknown,
): AssistantTurnValidationResult {
  if (!isRecord(value)) return invalid("record_invalid", "$");
  const unexpected = unexpectedField(
    value,
    new Set(["schemaVersion", "id", "status", "segments", "items"]),
  );
  if (unexpected) return invalid("field_unexpected", unexpected);
  if (value.schemaVersion !== 1) {
    return invalid("schema_version_unsupported", "schemaVersion");
  }
  if (!isOneOf(value.status, TURN_STATUSES)) {
    return invalid("status_invalid", "status");
  }
  if (!isBoundedNonEmptyString(value.id, ASSISTANT_TURN_MAX_ID_CHARS)) {
    return invalid("id_invalid", "id");
  }
  if (!Array.isArray(value.segments)) {
    return invalid("segments_invalid", "segments");
  }
  if (value.segments.length > ASSISTANT_TURN_MAX_SEGMENTS) {
    return invalid("segments_too_many", "segments");
  }
  if (!Array.isArray(value.items)) {
    return invalid("items_invalid", "items");
  }
  if (value.items.length > ASSISTANT_TURN_MAX_ITEMS) {
    return invalid("items_too_many", "items");
  }

  const context: ValidationContext = {
    domainIds: new Set([value.id]),
    segmentIndices: new Map<string, number>(),
    toolCallIds: new Set<string>(),
  };
  const segmentFailure = validateSegments(value.segments, context);
  if (segmentFailure) return { ok: false, reason: segmentFailure };
  const itemFailure = validateItems(value.items, context);
  if (itemFailure) return { ok: false, reason: itemFailure };

  return { ok: true, value: value as unknown as AssistantTurnRecord };
}

export function validateProviderReplayCapsule(
  value: unknown,
): ProviderReplayCapsuleValidationResult {
  if (!isRecord(value)) return capsuleInvalid("capsule_invalid", "$");
  const unexpected = unexpectedField(
    value,
    new Set(["provider", "version", "thinkingBlocks"]),
  );
  if (unexpected) {
    return capsuleInvalid("capsule_field_unexpected", unexpected);
  }
  if (value.provider !== "anthropic") {
    return capsuleInvalid("capsule_provider_invalid", "provider");
  }
  if (value.version !== 1) {
    return capsuleInvalid("capsule_version_unsupported", "version");
  }
  if (
    !Array.isArray(value.thinkingBlocks) ||
    value.thinkingBlocks.length > MAX_REPLAY_CAPSULE_BLOCKS
  ) {
    return capsuleInvalid("capsule_blocks_invalid", "thinkingBlocks");
  }

  const serializedLength = serializedJsonLength(value);
  if (
    serializedLength === null ||
    serializedLength > ASSISTANT_TURN_MAX_REPLAY_CAPSULE_CHARS
  ) {
    return capsuleInvalid("capsule_too_large", "$");
  }

  const thinkingBlocks = value.thinkingBlocks as unknown[];
  for (let index = 0; index < thinkingBlocks.length; index += 1) {
    const block: unknown = thinkingBlocks[index];
    const path = `thinkingBlocks[${index}]`;
    if (!isRecord(block)) {
      return capsuleInvalid("capsule_block_invalid", path);
    }
    if (block.type === "thinking") {
      const blockUnexpected = unexpectedField(
        block,
        new Set(["type", "thinking", "signature"]),
        path,
      );
      if (
        blockUnexpected ||
        typeof block.thinking !== "string" ||
        !isBoundedNonEmptyString(
          block.signature,
          ASSISTANT_TURN_MAX_REPLAY_CAPSULE_CHARS,
        )
      ) {
        return capsuleInvalid(
          "capsule_block_invalid",
          blockUnexpected ?? path,
        );
      }
      continue;
    }
    if (block.type === "redacted_thinking") {
      const blockUnexpected = unexpectedField(
        block,
        new Set(["type", "data"]),
        path,
      );
      if (
        blockUnexpected ||
        !isBoundedNonEmptyString(
          block.data,
          ASSISTANT_TURN_MAX_REPLAY_CAPSULE_CHARS,
        )
      ) {
        return capsuleInvalid(
          "capsule_block_invalid",
          blockUnexpected ?? path,
        );
      }
      continue;
    }
    return capsuleInvalid("capsule_block_invalid", path);
  }

  return { ok: true, value: value as unknown as ProviderReplayCapsule };
}

function validateSegments(
  segments: unknown[],
  context: ValidationContext,
): AssistantTurnInvalidReason | null {
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const path = `segments[${index}]`;
    if (!isRecord(segment)) return reason("segments_invalid", path);
    const unexpected = unexpectedField(
      segment,
      new Set(["id", "providerMessageId", "replayCapsule"]),
      path,
    );
    if (unexpected) return reason("field_unexpected", unexpected);
    if (!isBoundedNonEmptyString(segment.id, ASSISTANT_TURN_MAX_ID_CHARS)) {
      return reason("id_invalid", `${path}.id`);
    }
    if (context.domainIds.has(segment.id)) {
      return reason("id_duplicate", `${path}.id`);
    }
    context.domainIds.add(segment.id);
    context.segmentIndices.set(segment.id, index);

    if (
      segment.providerMessageId !== undefined &&
      !isBoundedNonEmptyString(
        segment.providerMessageId,
        MAX_PROVIDER_MESSAGE_ID_CHARS,
      )
    ) {
      return reason(
        "provider_message_id_invalid",
        `${path}.providerMessageId`,
      );
    }
    if (segment.replayCapsule !== undefined) {
      const capsuleResult = validateProviderReplayCapsule(
        segment.replayCapsule,
      );
      if (!capsuleResult.ok) {
        return reason(
          "replay_capsule_invalid",
          `${path}.replayCapsule`,
          capsuleResult.reason.code,
        );
      }
    }
  }
  return null;
}

function validateItems(
  items: unknown[],
  context: ValidationContext,
): AssistantTurnInvalidReason | null {
  let lastSegmentIndex = -1;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const path = `items[${index}]`;
    if (!isRecord(item)) return reason("item_type_invalid", path);

    const commonFailure = validateItemCommon(item, path, context);
    if (commonFailure) return commonFailure;
    const segmentIndex = context.segmentIndices.get(item.segmentId as string);
    if (segmentIndex === undefined) {
      return reason("segment_membership_invalid", `${path}.segmentId`);
    }
    if (segmentIndex < lastSegmentIndex) {
      return reason("segment_order_invalid", `${path}.segmentId`);
    }
    lastSegmentIndex = segmentIndex;

    const specificFailure =
      item.type === "prose"
        ? validateProseItem(item, path)
        : item.type === "tool_call"
          ? validateToolItem(item, path, context)
          : reason("item_type_invalid", `${path}.type`);
    if (specificFailure) return specificFailure;
  }
  return null;
}

function validateItemCommon(
  item: Record<string, unknown>,
  path: string,
  context: ValidationContext,
): AssistantTurnInvalidReason | null {
  if (!isBoundedNonEmptyString(item.id, ASSISTANT_TURN_MAX_ID_CHARS)) {
    return reason("id_invalid", `${path}.id`);
  }
  if (context.domainIds.has(item.id)) {
    return reason("id_duplicate", `${path}.id`);
  }
  context.domainIds.add(item.id);
  if (!isBoundedNonEmptyString(item.segmentId, ASSISTANT_TURN_MAX_ID_CHARS)) {
    return reason("segment_membership_invalid", `${path}.segmentId`);
  }
  if (
    item.sourceItemId !== undefined &&
    !isBoundedNonEmptyString(
      item.sourceItemId,
      ASSISTANT_TURN_MAX_ID_CHARS,
    )
  ) {
    return reason("source_item_id_invalid", `${path}.sourceItemId`);
  }
  return null;
}

function validateProseItem(
  item: Record<string, unknown>,
  path: string,
): AssistantTurnInvalidReason | null {
  const unexpected = unexpectedField(
    item,
    new Set([
      "type",
      "id",
      "segmentId",
      "sourceItemId",
      "text",
      "actionRef",
      "actionAnchor",
    ]),
    path,
  );
  if (unexpected) return reason("field_unexpected", unexpected);
  if (typeof item.text !== "string" || item.text.length === 0) {
    return reason("prose_empty", `${path}.text`);
  }
  if (item.text.length > ASSISTANT_TURN_MAX_PROSE_CHARS) {
    return reason("prose_too_long", `${path}.text`);
  }

  const hasActionRef = item.actionRef !== undefined;
  const hasActionAnchor = item.actionAnchor !== undefined;
  if (
    hasActionRef &&
    !isBoundedNonEmptyString(item.actionRef, ASSISTANT_TURN_MAX_ID_CHARS)
  ) {
    return reason("action_ref_invalid", `${path}.actionRef`);
  }
  if (
    hasActionRef !== hasActionAnchor ||
    (hasActionAnchor && item.actionAnchor !== "parsed_edit")
  ) {
    return reason("prose_action_invalid", path);
  }
  return null;
}

function validateToolItem(
  item: Record<string, unknown>,
  path: string,
  context: ValidationContext,
): AssistantTurnInvalidReason | null {
  const unexpected = unexpectedField(item, TOOL_ITEM_FIELDS, path);
  if (unexpected) return reason("field_unexpected", unexpected);
  const declarationFailure = validateToolDeclaration(item, path, context);
  if (declarationFailure) return declarationFailure;
  const lifecycleFailure = validateToolLifecycleFields(item, path);
  if (lifecycleFailure) return lifecycleFailure;
  return validateAskFields(item, path);
}

const TOOL_ITEM_FIELDS = new Set([
  "type",
  "id",
  "segmentId",
  "sourceItemId",
  "toolCallId",
  "toolName",
  "toolArguments",
  "toolArgs",
  "toolInput",
  "state",
  "resultRecord",
  "resultDigest",
  "isError",
  "errorContent",
  "actionRef",
  "askGuidance",
  "askStatus",
  "round",
]);

function validateToolDeclaration(
  item: Record<string, unknown>,
  path: string,
  context: ValidationContext,
): AssistantTurnInvalidReason | null {
  if (!isBoundedNonEmptyString(item.toolCallId, ASSISTANT_TURN_MAX_ID_CHARS)) {
    return reason("tool_call_id_invalid", `${path}.toolCallId`);
  }
  if (context.toolCallIds.has(item.toolCallId)) {
    return reason("tool_call_id_duplicate", `${path}.toolCallId`);
  }
  context.toolCallIds.add(item.toolCallId);
  if (
    !isBoundedNonEmptyString(
      item.toolName,
      ASSISTANT_TURN_MAX_TOOL_NAME_CHARS,
    )
  ) {
    return reason("tool_name_invalid", `${path}.toolName`);
  }
  if (typeof item.toolArguments !== "string") {
    return reason("tool_arguments_invalid", `${path}.toolArguments`);
  }
  if (item.toolArguments.length > ASSISTANT_TURN_MAX_TOOL_ARGUMENTS_CHARS) {
    return reason("tool_arguments_too_long", `${path}.toolArguments`);
  }
  if (item.toolArgs !== undefined) {
    const parsed = parseJsonObject(item.toolArguments);
    if (
      parsed === null ||
      !isJsonValue(item.toolArgs, 0, new Set<object>()) ||
      !isRecord(item.toolArgs)
    ) {
      return reason("tool_args_invalid", `${path}.toolArgs`);
    }
    if (!valuesEqual(parsed, item.toolArgs)) {
      return reason("tool_args_mismatch", `${path}.toolArgs`);
    }
  }
  if (
    item.toolInput !== undefined &&
    !isBoundedString(item.toolInput, ASSISTANT_TURN_MAX_TOOL_INPUT_CHARS)
  ) {
    return reason("tool_input_invalid", `${path}.toolInput`);
  }
  if (
    item.actionRef !== undefined &&
    !isBoundedNonEmptyString(item.actionRef, ASSISTANT_TURN_MAX_ID_CHARS)
  ) {
    return reason("action_ref_invalid", `${path}.actionRef`);
  }
  return null;
}

function validateToolLifecycleFields(
  item: Record<string, unknown>,
  path: string,
): AssistantTurnInvalidReason | null {
  if (!isOneOf(item.state, TOOL_STATES)) {
    return reason("tool_state_invalid", `${path}.state`);
  }
  const resultRecordFailure = validateOptionalBoundedString(
    item.resultRecord,
    ASSISTANT_TURN_MAX_RESULT_RECORD_CHARS,
    "result_record_invalid",
    "result_record_too_long",
    `${path}.resultRecord`,
  );
  if (resultRecordFailure) return resultRecordFailure;
  const resultDigestFailure = validateOptionalBoundedString(
    item.resultDigest,
    ASSISTANT_TURN_MAX_RESULT_DIGEST_CHARS,
    "result_digest_invalid",
    "result_digest_too_long",
    `${path}.resultDigest`,
  );
  if (resultDigestFailure) return resultDigestFailure;
  if (item.isError !== undefined && typeof item.isError !== "boolean") {
    return reason("is_error_invalid", `${path}.isError`);
  }
  const errorContentFailure = validateOptionalBoundedString(
    item.errorContent,
    ASSISTANT_TURN_MAX_ERROR_CONTENT_CHARS,
    "error_content_invalid",
    "error_content_too_long",
    `${path}.errorContent`,
  );
  if (errorContentFailure) return errorContentFailure;
  if (
    item.round !== undefined &&
    (!Number.isSafeInteger(item.round) || (item.round as number) < 0)
  ) {
    return reason("round_invalid", `${path}.round`);
  }
  return null;
}

function validateAskFields(
  item: Record<string, unknown>,
  path: string,
): AssistantTurnInvalidReason | null {
  if (item.askStatus !== undefined && !isOneOf(item.askStatus, ASK_STATUSES)) {
    return reason("ask_status_invalid", `${path}.askStatus`);
  }
  if (item.askGuidance === undefined) {
    return item.askStatus === "completed"
      ? reason("ask_guidance_invalid", `${path}.askGuidance`)
      : null;
  }
  if (item.askStatus !== "completed" || !isValidAskGuidance(item.askGuidance)) {
    return reason("ask_guidance_invalid", `${path}.askGuidance`);
  }
  return null;
}

function isValidAskGuidance(value: unknown): boolean {
  if (
    !isRecord(value) ||
    unexpectedField(value, new Set(["questions"])) !== null ||
    !Array.isArray(value.questions) ||
    value.questions.length === 0 ||
    value.questions.length > MAX_ASK_QUESTIONS
  ) {
    return false;
  }
  return value.questions.every((question) => {
    if (
      !isRecord(question) ||
      unexpectedField(
        question,
        new Set(["question", "header", "answer"]),
      ) !== null ||
      !isBoundedNonEmptyString(question.question, MAX_ASK_TEXT_CHARS) ||
      !isBoundedNonEmptyString(question.header, MAX_ASK_TEXT_CHARS)
    ) {
      return false;
    }
    if (typeof question.answer === "string") {
      return question.answer.length <= MAX_ASK_TEXT_CHARS;
    }
    return (
      Array.isArray(question.answer) &&
      question.answer.length <= MAX_ASK_ANSWER_OPTIONS &&
      question.answer.every((answer) =>
        isBoundedString(answer, MAX_ASK_TEXT_CHARS),
      )
    );
  });
}

function validateOptionalBoundedString(
  value: unknown,
  maxLength: number,
  invalidCode: AssistantTurnInvalidReasonCode,
  tooLongCode: AssistantTurnInvalidReasonCode,
  path: string,
): AssistantTurnInvalidReason | null {
  if (value === undefined) return null;
  if (typeof value !== "string") return reason(invalidCode, path);
  if (value.length > maxLength) return reason(tooLongCode, path);
  return null;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isJsonValue(
  value: unknown,
  depth: number,
  seen: Set<object>,
): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > MAX_JSON_DEPTH || seen.has(value)) {
    return false;
  }
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonValue(entry, depth + 1, seen))
    : isRecord(value) &&
      Object.values(value).every((entry) =>
        isJsonValue(entry, depth + 1, seen),
      );
  seen.delete(value);
  return valid;
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
    return left.every((entry, index) => valuesEqual(entry, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && valuesEqual(left[key], right[key]),
    )
  );
}

function serializedJsonLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : serialized.length;
  } catch {
    return null;
  }
}

function unexpectedField(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  basePath = "",
): string | null {
  const field = Object.keys(value).find((key) => !allowed.has(key));
  if (field === undefined) return null;
  return basePath.length === 0 ? field : `${basePath}.${field}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedNonEmptyString(
  value: unknown,
  maxLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength
  );
}

function isBoundedString(
  value: unknown,
  maxLength: number,
): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function isOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function invalid(
  code: AssistantTurnInvalidReasonCode,
  path: string,
  detail?: string,
): AssistantTurnValidationResult {
  return { ok: false, reason: reason(code, path, detail) };
}

function reason(
  code: AssistantTurnInvalidReasonCode,
  path: string,
  detail?: string,
): AssistantTurnInvalidReason {
  return { code, path, ...(detail === undefined ? {} : { detail }) };
}

function capsuleInvalid(
  code: ProviderReplayCapsuleInvalidReasonCode,
  path: string,
  detail?: string,
): ProviderReplayCapsuleValidationResult {
  return {
    ok: false,
    reason: { code, path, ...(detail === undefined ? {} : { detail }) },
  };
}
